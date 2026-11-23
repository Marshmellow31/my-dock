'use strict';

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { DockPosition } from './dock.js';
import {
  get_distance_sqr,
  get_distance,
  isInRect,
  isOverlapRect,
} from './utils.js';

const DEBOUNCE_HIDE_TIMEOUT = 120;
const PRESSURE_SENSE_DISTANCE = 40;

// [local patch] Safety net for the 2px reveal strip: while the dock is hidden,
// poll the pointer and reveal when it rests against the dock's screen edge.
// Covers cases where the strip never gets an enter-event (seen with maximized
// Claude Desktop on GNOME 51), and stops hide/show flicker at the edge (Chrome).
const EDGE_POLL_MS = 150;
const EDGE_BAND = 3; // px from the screen edge that count as "at the edge"
const EDGE_POLLS_TO_REVEAL = 2; // ~300ms resting at the edge

// Set to true to log every show/hide with its cause (journalctl --user | grep d2d-autohide).
const DEBUG = false;
function dbg(msg) {
  if (DEBUG) console.log(`[d2d-autohide] ${msg}`);
}

// some codes lifted from dash-to-dock intellihide
const handledWindowTypes = [
  Meta.WindowType.NORMAL,
  // Meta.WindowType.DOCK,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  // Meta.WindowType.TOOLBAR,
  // Meta.WindowType.MENU,
  Meta.WindowType.UTILITY,
  // Meta.WindowType.SPLASHSCREEN
];

export let AutoHide = class {
  enable() {
    if (this._enabled) return;
    // console.log('enable autohide');
    this._enabled = true;
    this._shown = true;
    this._dwell = 0;
    this._setScanoutBlocked(true);
    console.log('autohide enabled');
  }

  disable() {
    if (!this._enabled) return;
    if (this.extension._hiTimer) {
      this.extension._hiTimer.cancel(this._animationSeq);
    }

    this.show();
    this._stopEdgePoll();
    this._setScanoutBlocked(false);

    this._enabled = false;

    let actors = global.get_window_actors();
    let windows = actors.map((a) => a.get_meta_window());
    windows.forEach((w) => {
      if (w._tracked) {
        this._untrack(w);
      }
    });

    console.log('autohide disabled');
  }

  _getScaleFactor() {
    //! use dock scale factor
    let scaleFactor = this.dock._monitor.geometry_scale;
    return scaleFactor;
  }

  _onMotionEvent() {
    if (this.extension.pressure_sense && !this._shown) {
      let monitor = this.dock._monitor;
      let pointer = global.get_pointer();
      if (this.extension.simulated_pointer) {
        pointer = [...this.extension.simulated_pointer];
      }

      let sw = monitor.width;
      let sh = monitor.height;
      let scale = this._getScaleFactor();
      let area = scale * (PRESSURE_SENSE_DISTANCE * PRESSURE_SENSE_DISTANCE);
      let dx = 0;
      let dy = 0;

      if (this.last_pointer) {
        dx = pointer[0] - this.last_pointer[0];
        dx = dx * dx;
        dy = pointer[1] - this.last_pointer[1];
        dy = dy * dy;
      }

      let dwell_count =
        80 - 60 * (this.extension.pressure_sense_sensitivity || 0);

      if (this.dock.isVertical()) {
        if (
          // right
          (this.dock._position == DockPosition.RIGHT &&
            dy < area &&
            pointer[0] > monitor.x + sw - 4) ||
          // left
          (this.dock._position == DockPosition.LEFT &&
            dy < area &&
            pointer[0] < monitor.x + 4)
        ) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      } else {
        // bottom
        if (dx < area && pointer[1] + 4 > monitor.y + sh) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      }

      // console.log(`${this._dwell} ${dwell_count} ${this.extension.pressure_sense_sensitivity}`);

      if (this._dwell > dwell_count) {
        this.show('pressure');
      }
    }
  }

  _onEnterEvent() {
    if (!this.extension.pressure_sense) {
      this.show();
    }
  }

  _onLeaveEvent() {
    if (this._shown) {
      this._dwell = 0;
      this._debounceCheckHide();
    }
  }

  _onFocusWindow() {
    this._debounceCheckHide();
  }

  _onFullScreen() {
    this._debounceCheckHide();
  }

  show(cause = 'enter') {
    if (!this.dock._monitor || this.dock._monitor.inFullscreen) {
      if (DEBUG && !this._shown) dbg(`show(${cause}) blocked: monitor fullscreen`);
      return;
    }
    if (DEBUG && !this._shown) dbg(`show by ${cause}`);
    this._dwell = 0;
    this.frameDelay = 0;
    this._shown = true;
    this._stopEdgePoll();
    this._setScanoutBlocked(true);
    this.dock.slideIn();
  }

  hide(cause = 'check') {
    if (DEBUG && this._shown) dbg(`hide by ${cause}`);
    this._dwell = 0;
    this.frameDelay = 10;
    this._shown = false;
    this.dock.slideOut();
    this._startEdgePoll();
    this._releaseScanoutSoon();
  }

  // ── [local patch] direct scanout ──────────────────────────────────────
  // With a real GPU, mutter hands a window that covers the whole screen
  // (maximized + auto-hidden top bar) straight to the display ("direct
  // scanout"), skipping compositing. The dock then slides in but is never
  // drawn (Claude Desktop) or blinks as scanout toggles (Chrome). GNOME's own
  // window manager blocks scanout during its animations the same way.
  _setScanoutBlocked(blocked) {
    if (this._scanoutReleaseId) {
      GLib.source_remove(this._scanoutReleaseId);
      this._scanoutReleaseId = 0;
    }
    if (blocked === !!this._scanoutBlocked) return;
    if (DEBUG) dbg(`scanout ${blocked ? 'blocked' : 'allowed'}`);
    this._scanoutBlocked = blocked;
    if (blocked) global.compositor.disable_unredirect();
    else global.compositor.enable_unredirect();
  }

  // Keep compositing until the slide-out animation has finished.
  _releaseScanoutSoon() {
    if (this._scanoutReleaseId || !this._scanoutBlocked) return;
    this._scanoutReleaseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      this._scanoutReleaseId = 0;
      if (!this._shown) this._setScanoutBlocked(false);
      return GLib.SOURCE_REMOVE;
    });
  }

  // ── [local patch] edge polling ─────────────────────────────────────────
  // True when the pointer is pressed against the screen edge the dock lives on.
  _isPointerAtEdge(pointer) {
    const m = this.dock._monitor;
    if (!m) return false;
    const [x, y] = pointer;
    if (x < m.x || x >= m.x + m.width || y < m.y || y >= m.y + m.height) return false;
    switch (this.dock._position) {
      case DockPosition.LEFT:
        return x <= m.x + EDGE_BAND;
      case DockPosition.RIGHT:
        return x >= m.x + m.width - 1 - EDGE_BAND;
      case DockPosition.TOP:
        return y <= m.y + EDGE_BAND;
      default:
        return y >= m.y + m.height - 1 - EDGE_BAND;
    }
  }

  _startEdgePoll() {
    if (this._edgePollId || !this._enabled) return;
    this._edgeHits = 0;
    this._edgePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EDGE_POLL_MS, () => {
      if (!this._enabled || this._shown) {
        this._edgePollId = 0;
        return GLib.SOURCE_REMOVE;
      }
      // Pressure-sense mode has its own dwell logic; respect it.
      if (this.extension.pressure_sense) return GLib.SOURCE_CONTINUE;
      if (this._isPointerAtEdge(global.get_pointer())) {
        if (++this._edgeHits >= EDGE_POLLS_TO_REVEAL) {
          this._edgePollId = 0; // show() would remove it too; avoid double removal
          this.show('edge-poll');
          return GLib.SOURCE_REMOVE;
        }
      } else {
        this._edgeHits = 0;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopEdgePoll() {
    if (this._edgePollId) {
      GLib.source_remove(this._edgePollId);
      this._edgePollId = 0;
    }
  }

  _track(window) {
    //! window tracking should be made global
    if (!window._tracked) {
      window.connectObject(
        'position-changed',
        // this._debounceCheckHide.bind(this),
        () => {
          this.dock.extension.checkHide();
        },
        'size-changed',
        // this._debounceCheckHide.bind(this),
        () => {
          this.dock.extension.checkHide();
        },
        this
      );
      window._tracked = true;
    }
  }

  _untrack(window) {
    try {
      if (window && window._tracked) {
        window.disconnectObject(this);
        window._tracked = false;
      }
    } catch (err) {
      // may have been destroyed already
    }
  }

  _checkOverlap() {
    // console.log("checking overlap...");
    if (this.extension._inOverview) {
      return false;
    }
    let pointer = global.get_pointer();
    if (this.extension.simulated_pointer) {
      pointer = [...this.extension.simulated_pointer];
    }

    // console.log(pointer);

    let pos = this.dock.struts.get_transformed_position();
    let rect = {
      x: pos[0],
      y: pos[1],
      w: this.dock.struts.width,
      h: this.dock.struts.height,
    };
    //! change to struts rect
    let arect = [rect.x, rect.y, rect.w, rect.h];

    // console.log(arect);

    if (!this.extension.autohide_dash) {
      return false;
    }

    // console.log("checking pointer location...");

    if (this.dock._isWithinDash(pointer) || isInRect(arect, pointer)) {
      return false;
    }

    // [local patch] Never hide while the pointer is pushing against the dock's
    // edge: hiding there and re-showing on the next event is the flicker.
    if (this._shown && this._isPointerAtEdge(pointer)) {
      return false;
    }

    if (!this.extension.autohide_dodge) {
      this._overlapWith = 'always-hide';
      return true;
    }

    // console.log("checking fullscreen...");

    if (this.dock._monitor && this.dock._monitor.inFullscreen) {
      this._overlapWith = 'fullscreen';
      return true;
    }

    // console.log("checking windows...");

    let monitor = this.dock._monitor;
    let actors = global.get_window_actors();
    let windows = actors.map((a) => {
      let w = a.get_meta_window();
      w._parent = a;
      return w;
    });
    windows = windows.filter((w) => w.can_close());
    windows = windows.filter((w) => w.get_monitor() == monitor.index);
    // windows = windows.filter((w) => !w.is_override_redirect());
    let workspace = global.workspace_manager.get_active_workspace_index();
    windows = windows.filter(
      (w) =>
        workspace == w.get_workspace().index() && w.showing_on_its_workspace()
    );
    // [local patch] was `type in handledWindowTypes`, which tests array *indexes*
    // (0-3), so it matched DESKTOP/DOCK windows and skipped UTILITY ones.
    windows = windows.filter((w) => handledWindowTypes.includes(w.get_window_type()));

    let isOverlapped = false;
    let dockRect = this.dock.struts.get_transformed_position();
    dockRect.push(this.dock.struts.width);
    dockRect.push(this.dock.struts.height);

    windows.forEach((w) => {
      this._track(w);
      if (isOverlapped) return;

      let frame = w.get_frame_rect();
      let win = [frame.x, frame.y, frame.width, frame.height];

      if (isOverlapRect(dockRect, win)) {
        isOverlapped = true;
        if (DEBUG) this._overlapWith = `window "${w.get_title()}"`;
      }
    });

    this.windows = windows;

    // console.log(isOverlapped);
    return isOverlapped;
  }

  _debounceCheckHide() {
    if (this.extension._loTimer) {
      if (!this._debounceCheckSeq) {
        this._debounceCheckSeq = this.extension._loTimer.runDebounced(
          () => {
            this._checkHide();
          },
          DEBOUNCE_HIDE_TIMEOUT,
          'debounceCheckHide'
        );
      } else {
        this.extension._loTimer.runDebounced(this._debounceCheckSeq);
      }
    }
  }

  _checkHide() {
    if (this._enabled) {
      this._overlapWith = null;
      if (this._checkOverlap()) {
        this.hide(DEBUG ? `${this._overlapWith ?? 'overlap'} ptr=${global.get_pointer().slice(0, 2)}` : undefined);
      } else {
        this.show('no-overlap');
      }
    }
  }
};
