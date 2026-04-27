#!/usr/bin/env bash
set -euo pipefail

# Max installer — https://github.com/burkeholland/max
# Usage: curl -fsSL https://raw.githubusercontent.com/burkeholland/max/main/install.sh | bash
# Dev:   ./install.sh --dev  (skips npm install, runs setup from local source)

DEV_MODE=false
if [ "${1:-}" = "--dev" ]; then
  DEV_MODE=true
fi

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info() { echo -e "${BOLD}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warn() { echo -e "${YELLOW}$1${RESET}"; }
error() { echo -e "${RED}$1${RESET}" >&2; }

echo ""
info "╔══════════════════════════════════════════╗"
info "║         🤖  Max Installer                ║"
info "╚══════════════════════════════════════════╝"
echo ""

if [ "$DEV_MODE" = true ]; then
  warn "  ⚡ Dev mode — skipping npm install, using local build"
  echo ""
fi

# On Windows (Git Bash / MSYS2 / Cygwin) the shell launched by `curl … | bash`
# may not inherit the full Windows PATH, so Node.js won't be found even when it
# is installed.  Prepend the most common installation directories so the checks
# below work reliably.
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*)
    for _win_node_path in \
      "/c/Program Files/nodejs" \
      "/c/Program Files (x86)/nodejs"; do
      [ -d "$_win_node_path" ] && export PATH="$_win_node_path:$PATH"
    done
    unset _win_node_path
    # LOCALAPPDATA and APPDATA are Windows-format paths; convert them with
    # cygpath (available in all MSYS2/Cygwin environments) before use.
    if command -v cygpath &>/dev/null; then
      if [ -n "${LOCALAPPDATA:-}" ]; then
        _lad="$(cygpath -u "$LOCALAPPDATA")"
        [ -d "$_lad/Programs/node" ] && export PATH="$_lad/Programs/node:$PATH"
        unset _lad
      fi
      if [ -n "${APPDATA:-}" ]; then
        _ad="$(cygpath -u "$APPDATA")"
        [ -d "$_ad/npm" ] && export PATH="$_ad/npm:$PATH"
        unset _ad
      fi
    fi
    ;;
esac

# Check Node.js — accept both `node` (Unix) and `node.exe` (Windows)
NODE_CMD=""
if command -v node &>/dev/null; then
  NODE_CMD="node"
elif command -v node.exe &>/dev/null; then
  NODE_CMD="node.exe"
fi

if [ -z "$NODE_CMD" ]; then
  error "✗ Node.js is required but not installed."
  echo "  Install it from https://nodejs.org (v18 or later)"
  exit 1
fi

NODE_VERSION=$($NODE_CMD -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "✗ Node.js v18+ is required (found $($NODE_CMD -v))"
  echo "  Update from https://nodejs.org"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $($NODE_CMD -v)"

# Check npm — accept both `npm` (Unix) and `npm.cmd` / `npm.exe` (Windows)
NPM_CMD=""
if command -v npm &>/dev/null; then
  NPM_CMD="npm"
elif command -v npm.cmd &>/dev/null; then
  NPM_CMD="npm.cmd"
elif command -v npm.exe &>/dev/null; then
  NPM_CMD="npm.exe"
fi

if [ -z "$NPM_CMD" ]; then
  error "✗ npm is required but not installed."
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} npm $($NPM_CMD -v)"

# Check Copilot CLI
if command -v copilot &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} Copilot CLI found"
else
  warn "  ⚠ Copilot CLI not found — you'll need it before starting Max"
  echo -e "    ${DIM}Install: npm install -g @github/copilot${RESET}"
fi

# Check gogcli (optional — Google services)
if command -v gog &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} gogcli found (Google services)"
else
  echo -e "  ${DIM}○ gogcli not found (optional — enables Gmail, Calendar, Drive, etc.)${RESET}"
  echo -e "    ${DIM}Install: brew install steipete/tap/gogcli${RESET}"
fi

echo ""

if [ "$DEV_MODE" = true ]; then
  # Dev mode: build locally and run setup from source
  info "Building from local source..."
  $NPM_CMD run build
  echo ""
  info "Running setup from local build..."
  echo ""
  $NODE_CMD dist/setup.js < /dev/tty
else
  info "Installing heymax..."
  $NPM_CMD install -g heymax
  echo ""
  success "✅ Max installed successfully!"
  echo ""
  info "Let's get Max configured..."
  echo ""
  max setup < /dev/tty
fi
