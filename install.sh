#!/usr/bin/env bash
set -euo pipefail

# ─── Clawth Installer ───────────────────────────────────────────────────────
#
# Interactive:     ./install.sh
# Non-interactive: ./install.sh --passphrase "secret"
#                  ./install.sh --passphrase "secret" --agent "mybot"
#
# This script installs dependencies then delegates to `clawth setup`.
# All flags are forwarded to `clawth setup`.
# ────────────────────────────────────────────────────────────────────────────

CLAWTH_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
err()   { echo -e "${RED}[error]${NC} $*" >&2; }

# ── Check prerequisites ─────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  err "bun is required but not installed."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ── Install dependencies ────────────────────────────────────────────────────

info "Installing dependencies..."
(cd "${CLAWTH_DIR}" && bun install --frozen-lockfile 2>/dev/null || bun install)
ok "Dependencies installed."

# ── Delegate to clawth setup ─────────────────────────────────────────────────

echo ""
exec bun run "${CLAWTH_DIR}/bin/clawth.ts" setup "$@"
