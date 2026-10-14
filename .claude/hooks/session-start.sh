#!/bin/bash
# SessionStart hook: install dependencies in Claude Code cloud sessions so lint, typecheck,
# tests, builds and e2e work immediately. Local sessions are left alone.
#
# - Idempotent and fast: skips an install whose lockfile has not changed since the last
#   successful run (hash marker inside node_modules).
# - Never fails the session: every step logs and continues; the script always exits 0.
# - Never runs `playwright install`: cloud containers ship Chromium at /opt/pw-browsers, and
#   PW_CHROMIUM_PATH (read by playwright.config.ts) is exported for the session.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
log() { echo "[session-start] $*" >&2; }

# The cloud image installs bun with the official installer into ~/.bun/bin.
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
case ":$PATH:" in *":$BUN_INSTALL/bin:"*) ;; *) export PATH="$BUN_INSTALL/bin:$PATH" ;; esac

hash_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# install_deps <dir> <lockfile> <command...>
install_deps() {
  local dir="$1" lock="$2"
  shift 2
  local want have marker="$dir/node_modules/.session-start-lock-hash"
  want="$(hash_of "$dir/$lock")"
  have="$(cat "$marker" 2>/dev/null || true)"
  if [ -n "$want" ] && [ "$want" = "$have" ]; then
    log "$dir: $lock unchanged, skipping install"
    return 0
  fi
  log "$dir: running $*"
  if (cd "$dir" && "$@") >&2; then
    mkdir -p "$dir/node_modules" && echo "$want" >"$marker"
    log "$dir: install OK"
  else
    log "$dir: install FAILED (continuing; run it by hand to see the error)"
  fi
}

if command -v bun >/dev/null 2>&1; then
  install_deps "$ROOT" bun.lock bun install --frozen-lockfile
else
  log "bun not found on PATH; skipping web install (CI pins bun 1.4.2)"
fi

if command -v npm >/dev/null 2>&1; then
  install_deps "$ROOT/connector" package-lock.json npm ci --no-audit --no-fund
else
  log "npm not found on PATH; skipping connector install"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$BUN_INSTALL/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
  if [ -z "${PW_CHROMIUM_PATH:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
    echo 'export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium' >>"$CLAUDE_ENV_FILE"
  fi
fi

log "done"
exit 0
