# My Dock

A GNOME Shell dock with macOS-style magnification. It is a fork of
[Dash2Dock Animated](https://github.com/icedman/dash2dock-lite) by icedman.

## What is different from Dash2Dock Animated

- **Steady spread:** when the cursor reaches the dock it widens once, evenly on
  both sides. Icons away from the cursor then stay where they are.
- **No overlap:** each enlarged icon makes room for its own size. The "Icons
  spread" setting therefore has no effect.
- **Smooth start and finish:** magnification fades in and out.
- **Frosted background** (optional): blurs the wallpaper, or the windows behind
  the dock when Blur my Shell is running.
- **GNOME 51:** tint and monochrome icon effects ported to the new shader API.
- Own ID and settings, so it can sit next to the original.

## Requirements

Tested on GNOME Shell 51 (Wayland). `metadata.json` still lists 45 to 51, as
upstream does, but 45 to 50 are untested with these changes.

## Install

Turn off any other dock first (Dash to Dock, Ubuntu Dock, Dash2Dock Animated).

```bash
git clone https://github.com/Marshmellow31/my-dock.git
cd my-dock
./install.sh
```

Log out and back in, then:

```bash
gnome-extensions enable my-dock@local
```

`./install.sh --look` also applies the author's settings from `look.dconf`
(this overwrites any My Dock settings you already have, and includes top bar
styling). `./install.sh --uninstall` removes the extension.

## Licence and credits

GPL-3.0, see [LICENSE](LICENSE). Original work by icedman and the Dash2Dock
Animated contributors; modified from version 92 in November 2026. The upstream
README and changelog are kept in `my-dock@local/`. Please report problems with
this fork here, not upstream.
