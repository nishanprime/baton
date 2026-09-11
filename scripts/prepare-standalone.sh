#!/usr/bin/env bash
# Stage a Node binary as a Tauri sidecar, for a build that runs on machines
# without Node installed.
#
# This roughly 25x's the app (4MB -> ~120MB), which is why it is opt-in rather
# than the default build. Most people running an AI coding agent already have
# Node; the people who need this are the ones you hand a .dmg to.
set -euo pipefail

cd "$(dirname "$0")/.."
BIN_DIR="gui/src-tauri/binaries"
mkdir -p "$BIN_DIR"

NODE="${BATON_NODE:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "error: no node binary found to bundle. Set BATON_NODE to one." >&2
  exit 1
fi

# Tauri requires sidecars to be suffixed with the Rust target triple.
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
DEST="$BIN_DIR/node-$TRIPLE"

cp "$NODE" "$DEST"
chmod +x "$DEST"

# A copied binary keeps the original's signature, which no longer matches on
# macOS and gets it killed on launch. Re-sign ad-hoc.
if [ "$(uname)" = "Darwin" ]; then
  codesign --force --sign - "$DEST" 2>/dev/null || \
    echo "warning: could not re-sign $DEST; it may be blocked at launch" >&2
fi

echo "staged $("$DEST" --version) at $DEST ($(du -h "$DEST" | cut -f1))"
