// LOCAL PATCH (not part of upstream dash2dock-lite).
//
// A macOS-style frosted backdrop for the dock. blur-my-shell 78 refuses to
// blur dash2dock-lite, and dash2dock-lite 92 has no blur of its own, so this
// draws one: a copy of the wallpaper, blurred, colour-boosted and cut to the
// dock's rounded corners. It sits underneath the tinted #d2daBackground.
//
// Why the wallpaper and not "whatever is behind the dock" (live blur): the
// dock is rendered offscreen (offscreen_redirect ALWAYS), and a
// BACKGROUND-mode blur inside an offscreen buffer sees an empty buffer, not
// the screen. Blurring the wallpaper actor itself works everywhere, follows
// slideshow / day-night wallpapers automatically, and costs almost nothing
// because the blurred result is cached until the wallpaper changes.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

// Live blur of whatever is behind the dock comes from blur-my-shell's own
// backdrop pipeline (it copies from the real screen, which works even inside
// this offscreen-rendered dock). Without blur-my-shell we fall back to the
// blurred-wallpaper glass below.
const BMS_UUID = 'blur-my-shell@aunetx';
const LIVE_PIPELINE = 'pipeline_control_center'; // blur 40 + 1.35x vibrancy

const BLUR_RADIUS = 34;       // px, like macOS's heavy frost
const BLUR_BRIGHTNESS = 0.92; // a touch darker so white icons stay readable
const SATURATION = 1.4;       // macOS "vibrancy": colours behind glass pop

// Rounded-rectangle mask (signed distance, 1px anti-aliased edge) plus a
// saturation boost, applied to the glass layer's offscreen texture.
//
// GNOME 51's Clutter.ShaderEffect has no set_shader_source(): a subclass
// supplies a Cogl snippet from vfunc_get_static_snippet() (as the shell's
// own lightbox.js does). This "post" code runs after Cogl has already put
// the sampled texture colour (premultiplied) into cogl_color_out.
const MASK_DECLARATIONS = `
uniform float width;
uniform float height;
uniform float radius;
uniform float saturation;
`;

const MASK_CODE = `
vec4 c = cogl_color_out;

float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
c.rgb = clamp(mix(vec3(lum), c.rgb, saturation), 0.0, c.a);

vec2 size = vec2(width, height);
vec2 half_size = size * 0.5;
float r = min(radius, min(half_size.x, half_size.y));
vec2 p = cogl_tex_coord_in[0].st * size;
vec2 q = abs(p - half_size) - (half_size - vec2(r));
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
float a = clamp(0.5 - d, 0.0, 1.0);

cogl_color_out = c * a;
`;

const GlassMaskEffect = GObject.registerClass(
  {},
  class D2DAGlassMaskEffect extends Clutter.ShaderEffect {
    _init() {
      super._init({ name: 'd2daGlassMask' });
      this._w = this._h = this._r = -1;
      this.set_uniform_float('saturation', 1, [SATURATION]);
    }

    vfunc_get_static_snippet() {
      return Cogl.Snippet.new(
        Cogl.SnippetHook.FRAGMENT,
        MASK_DECLARATIONS,
        MASK_CODE
      );
    }

    setGeometry(width, height, radius) {
      if (width === this._w && height === this._h && radius === this._r)
        return;
      this._w = width;
      this._h = height;
      this._r = radius;
      this.set_uniform_float('width', 1, [width]);
      this.set_uniform_float('height', 1, [height]);
      this.set_uniform_float('radius', 1, [radius]);
      this.queue_repaint();
    }
  }
);

export class DockGlass {
  constructor(dock) {
    this._dock = dock;
    this._bgManager = null;
    this._monitorIndex = -1;

    this.actor = new St.Widget({
      name: 'd2daGlass',
      reactive: false,
      clip_to_allocation: true,
      visible: false,
    });

    // Monitor-sized holder for the wallpaper, shifted so the part under the
    // dock lines up with the real wallpaper on screen.
    this._holder = new St.Widget({ reactive: false });
    this._holder.add_effect(
      new Shell.BlurEffect({
        mode: Shell.BlurMode.ACTOR,
        radius: BLUR_RADIUS,
        brightness: BLUR_BRIGHTNESS,
      })
    );
    this.actor.add_child(this._holder);

    this._mask = new GlassMaskEffect();
    this.actor.add_effect(this._mask);

    // Live mode: borrow blur-my-shell's backdrop pipeline when it is running.
    this._live = null;
    this._liveRadius = -1;
    this._destroyed = false;
    Main.extensionManager.connectObject(
      'extension-state-changed',
      (_m, ext) => {
        if (ext?.uuid === BMS_UUID) this._refreshLive();
      },
      this
    );
    this._refreshLive();

    this.actor.connect('destroy', () => {
      this._destroyed = true;
      Main.extensionManager.disconnectObject(this);
      this._dropLive();
      this._destroyBackground();
    });
  }

  // ---- live blur (via blur-my-shell) ------------------------------------

  _bmsReady() {
    const ext = Main.extensionManager.lookup(BMS_UUID);
    const bms = global.blur_my_shell;
    return ext?.state === ExtensionState.ACTIVE &&
      bms?._effects_manager && bms?._pipelines_manager
      ? { ext, bms }
      : null;
  }

  _refreshLive() {
    const ready = this._bmsReady();
    if (!ready) {
      this._dropLive();
      return;
    }
    if (this._live || this._liveLoading) return;
    this._liveLoading = true;

    // Import by the exact URL blur-my-shell itself loaded, so we share its
    // module state (e.g. which stage view is being painted) instead of
    // getting a second, empty copy of the module.
    const url = Gio.File.new_for_path(
      `${ready.ext.path}/render/dynamic_surface.js`
    ).get_uri();

    import(url)
      .then(({ DynamicPipeline }) => {
        this._liveLoading = false;
        if (this._destroyed || this._live || !this._bmsReady()) return;

        const { bms } = ready;
        const pipelineId = Object.hasOwn(
          bms._pipelines_manager.pipelines ?? {},
          LIVE_PIPELINE
        )
          ? LIVE_PIPELINE
          : 'pipeline_default';

        this._liveRadius = this._dock.extension.computed_border_radius ?? 0;
        const live = new DynamicPipeline(
          bms._effects_manager,
          bms._pipelines_manager,
          pipelineId,
          {
            corner_radius: this._liveRadius,
            get_corners: () => 0, // all four corners rounded
          }
        );
        live.attach_to_container(this.actor, 'd2daLiveGlass');
        this._live = live;

        // The live pipeline rounds its own corners and adds its own vibrancy.
        this._holder.hide();
        this._mask.enabled = false;
        this._destroyBackground();
      })
      .catch((e) => {
        this._liveLoading = false;
        console.error(`[d2dl glass] live blur unavailable, using wallpaper: ${e}`);
      });
  }

  _dropLive() {
    if (!this._live) return;
    try {
      this._live.destroy();
    } catch (e) {
      console.error(`[d2dl glass] live teardown: ${e}`);
    }
    this._live = null;
    if (!this._destroyed) {
      this._holder.show();
      this._mask.enabled = true;
    }
  }

  _ensureBackground(monitorIndex) {
    if (this._bgManager && monitorIndex === this._monitorIndex) return;
    this._destroyBackground();
    this._monitorIndex = monitorIndex;
    this._bgManager = new Background.BackgroundManager({
      container: this._holder,
      monitorIndex,
      controlPosition: false,
    });
    // BackgroundManager starts at 0.5 brightness; replacement actors copy it.
    this._bgManager.backgroundActor.content.brightness = 1.0;
  }

  _destroyBackground() {
    this._bgManager?.destroy();
    this._bgManager = null;
    this._monitorIndex = -1;
  }

  /** Match the tinted background's geometry; call after it has updated. */
  sync() {
    const dock = this._dock;
    const bg = dock._background;
    const ext = dock.extension;

    const show =
      ext.blur_background &&
      bg.visible &&
      bg.opacity > 0 &&
      bg.width > 0 &&
      bg.height > 0;
    this.actor.visible = show;
    if (!show) return;

    const x = Math.round(bg.x);
    const y = Math.round(bg.y);
    const w = Math.round(bg.width);
    const h = Math.round(bg.height);
    this.actor.set_position(x, y);
    this.actor.set_size(w, h);

    if (this._live) {
      // Live mode follows our size by itself; only the radius may change.
      const r = ext.computed_border_radius ?? 0;
      if (r !== this._liveRadius) {
        this._liveRadius = r;
        this._live.set_corner_radius(r);
      }
      return;
    }

    const index = dock._monitorIndex ?? Main.layoutManager.primaryIndex;
    const monitor = Main.layoutManager.monitors[index];
    if (!monitor) return;
    this._ensureBackground(index);

    // Stage position of the glass = dock position (incl. autohide slide) + x/y.
    const sx = dock.x + dock.translation_x + x;
    const sy = dock.y + dock.translation_y + y;
    this._holder.set_position(
      Math.round(monitor.x - sx),
      Math.round(monitor.y - sy)
    );
    this._holder.set_size(monitor.width, monitor.height);

    this._mask.setGeometry(w, h, ext.computed_border_radius ?? 0);
  }
}
