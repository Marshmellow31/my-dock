#!/usr/bin/env bash
# Install, link or remove the My Dock GNOME Shell extension.
#
#   ./install.sh              copy into ~/.local/share/gnome-shell/extensions
#   ./install.sh --look       same, and also apply the author's dock settings
#   ./install.sh --link       symlink instead (handy while developing)
#   ./install.sh --uninstall  remove it
set -euo pipefail

UUID="my-dock@local"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/$UUID"
DEST_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
DEST="$DEST_ROOT/$UUID"

case "${1:-}" in
  --uninstall)
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removed $UUID"
    exit 0
    ;;
  ""|--link|--look) ;;
  *) echo "Usage: $0 [--look|--link|--uninstall]" >&2; exit 2 ;;
esac

command -v glib-compile-schemas >/dev/null || {
  echo "glib-compile-schemas not found (install libglib2.0-bin or glib2-devel)." >&2
  exit 1
}
if [ "${1:-}" = "--look" ] && ! command -v dconf >/dev/null; then
  echo "dconf not found (install dconf-cli or dconf)." >&2
  exit 1
fi

glib-compile-schemas "$SRC/schemas"
mkdir -p "$DEST_ROOT"
rm -rf "$DEST"

if [ "${1:-}" = "--link" ]; then
  ln -s "$SRC" "$DEST"
  echo "Linked $DEST -> $SRC"
else
  cp -r "$SRC" "$DEST"
  echo "Copied to $DEST"
fi

if [ "${1:-}" = "--look" ]; then
  dconf load /org/gnome/shell/extensions/my-dock/ < "$HERE/look.dconf"
  echo "Applied the author's dock settings."
fi

if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "Enabled $UUID. Log out and back in to load the new code."
else
  echo "Now log out and back in, then run: gnome-extensions enable $UUID"
fi
