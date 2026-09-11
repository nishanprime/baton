#!/usr/bin/env bash
# One command to go from a fresh clone to a running app.
#
# Checks what is needed, installs what it can, and is explicit about anything
# it cannot do for you. Safe to re-run: everything here is idempotent, and a
# second run with nothing missing just launches the app.
#
# Rust is the one heavy prerequisite, and it is only needed for the desktop
# app — the CLI is fully functional without it. So Rust is offered, never
# assumed, and declining leaves you with a working install rather than an error.
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

ASSUME_YES=0
CLI_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --cli-only) CLI_ONLY=1 ;;
    -h|--help)
      echo "Usage: pnpm start [--yes] [--cli-only]"
      echo "  --yes       install missing prerequisites without asking"
      echo "  --cli-only  skip the desktop app; no Rust needed"
      exit 0 ;;
  esac
done
# A non-interactive shell cannot answer a prompt; treat that as "do not install".
[ -t 0 ] || ASSUME_YES="${ASSUME_YES}"

ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  read -r reply
  [[ "$reply" =~ ^[Yy] ]]
}

bold "Baton"
dim "Checking what this machine needs…"
echo

# ---------------------------------------------------------------- node
if ! command -v node >/dev/null 2>&1; then
  die "Node is not installed. Baton needs Node 22.18 or newer: https://nodejs.org"
fi
NODE_RAW="$(node --version)"
NODE_NUM="${NODE_RAW#v}"
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  // Type stripping, which is how the TypeScript runs with no build step.
  process.exit(maj > 22 || (maj === 22 && min >= 18) ? 0 : 1);
' || die "Node $NODE_NUM is too old. Baton needs 22.18+, which is when it became able to run TypeScript directly."
ok "Node $NODE_NUM"

# ---------------------------------------------------------------- deps
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  dim "Installing dependencies…"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install
  else
    npm install --no-fund --no-audit
  fi
fi
ok "Dependencies"

# ---------------------------------------------------------------- rust
HAVE_RUST=0
if command -v cargo >/dev/null 2>&1; then
  HAVE_RUST=1
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  # Installed but not on PATH in this shell, which is the state rustup leaves
  # behind until a new login shell.
  . "$HOME/.cargo/env"
  HAVE_RUST=1
fi

if [ "$CLI_ONLY" = 1 ]; then
  HAVE_RUST=0
elif [ "$HAVE_RUST" = 0 ]; then
  echo
  warn "The desktop app needs Rust, which is not installed."
  dim "The command line works fully without it. Rust is about 500MB and takes a few minutes."
  if ask "Install Rust now?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    . "$HOME/.cargo/env"
    HAVE_RUST=1
    ok "Rust $(rustc --version | awk '{print $2}')"
  else
    dim "Skipping the app. Re-run this any time to build it."
  fi
else
  ok "Rust $(rustc --version | awk '{print $2}')"
fi

# ---------------------------------------------------------------- build
if [ "$HAVE_RUST" = 1 ]; then
  if ! command -v cargo-tauri >/dev/null 2>&1 && ! cargo tauri --version >/dev/null 2>&1; then
    dim "Installing the Tauri build tool (one time, a few minutes)…"
    cargo install tauri-cli --version "^2.0" --locked
  fi
  ok "Tauri build tool"

  dim "Building the app…"
  (cd gui/src-tauri && cargo tauri build --bundles app)

  APP="gui/src-tauri/target/release/bundle/macos/Baton.app"
  BIN="gui/src-tauri/target/release/baton-gui"
  echo
  if [ -d "$APP" ]; then
    ok "Built $APP"
    open "$APP" && dim "Baton is running — look for it in your menu bar."
  elif [ -x "$BIN" ]; then
    ok "Built $BIN"
    ("$BIN" >/dev/null 2>&1 &) && dim "Baton is running."
  else
    warn "The build finished but no app was produced. Run: pnpm build"
  fi
fi

# ---------------------------------------------------------------- next
echo
bold "Next"
if [ "$HAVE_RUST" = 1 ]; then
  dim "  The app is open. The same thing from the terminal:"
else
  dim "  Start here:"
fi
echo "    pnpm setup          the guided walkthrough"
echo "    pnpm cli -- status  what Baton can see right now"
echo
dim "  Baton moves real conversation history. Every command that writes"
dim "  takes --dry-run, and pnpm setup previews everything before touching a file."
