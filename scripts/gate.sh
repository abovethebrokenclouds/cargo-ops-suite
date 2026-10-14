#!/usr/bin/env bash
# Pre-push gate: the same checks CI runs (.github/workflows/ci.yml), in order, with a
# PASS/FAIL summary. Exits nonzero if any step fails.
#
#   bash scripts/gate.sh              # everything (web, connector, rebuild, e2e)
#   bash scripts/gate.sh --fast       # skip builds and e2e (lint, typecheck, inventory, unit tests)
#   bash scripts/gate.sh --web        # web steps only
#   bash scripts/gate.sh --connector  # connector steps only
#
# Flags combine (`--fast --web`). e2e runs only in a full run (needs both builds).
# Never runs `playwright install`; when /opt/pw-browsers/chromium exists (cloud containers)
# and PW_CHROMIUM_PATH is unset, it is used automatically.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

FAST=0 WEB=1 CONN=1 E2E=1
ONLY_SET=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --web)
      [ $ONLY_SET = 0 ] && WEB=0 CONN=0 && ONLY_SET=1
      WEB=1
      ;;
    --connector)
      [ $ONLY_SET = 0 ] && WEB=0 CONN=0 && ONLY_SET=1
      CONN=1
      ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done
[ $FAST = 1 ] && E2E=0
[ $ONLY_SET = 1 ] && E2E=0

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if [ -z "${PW_CHROMIUM_PATH:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium
fi

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cargo-ops-gate.XXXXXX")"
NAMES=() RESULTS=() TIMES=() NOTES=()
FAILED=0 BUILD_FAILED=0

# step <name> <command string>
step() {
  local name="$1" cmd="$2" log start secs rc note=""
  log="$LOG_DIR/$(printf '%02d' "${#NAMES[@]}")-${name//[^A-Za-z0-9]/_}.log"
  printf '\n==> %s\n    $ %s\n' "$name" "$cmd"
  start=$(date +%s)
  bash -c "$cmd" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  secs=$(($(date +%s) - start))
  # Pull a one-line test count out of the runner output where there is one.
  note="$(grep -E '^\s*Tests +[0-9]' "$log" | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | xargs)" # vitest
  [ -z "$note" ] && note="$(grep -E '^ℹ (tests|pass|fail) ' "$log" | tr '\n' ' ' | sed 's/ℹ //g' | xargs)" # node --test
  [ -z "$note" ] && note="$(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$log" | tr '\n' ' ' | xargs)" # playwright
  NAMES+=("$name") TIMES+=("${secs}s") NOTES+=("$note")
  if [ "$rc" = 0 ]; then RESULTS+=(PASS); else
    RESULTS+=(FAIL)
    FAILED=1
  fi
  return "$rc"
}

skip() {
  NAMES+=("$1") RESULTS+=(SKIP) TIMES+=("-") NOTES+=("$2")
}

if [ $WEB = 1 ]; then
  step "web: install" "bun install --frozen-lockfile"
  step "web: lint" "bun run lint"
  step "web: typecheck" "bun run typecheck"
  step "web: inventory" "bun run check:inventory"
  step "web: unit tests (vitest)" "bun run test"
  if [ $FAST = 0 ]; then
    step "web: build (SSR)" "bun run build" || BUILD_FAILED=1
    step "web: build:local (SPA)" "bun run build:local" || BUILD_FAILED=1
    step "web: no CDN fonts in output" \
      "! grep -rl 'fonts.googleapis.com\|fonts.gstatic.com' dist .output 2>/dev/null"
  fi
fi

if [ $CONN = 1 ]; then
  step "connector: npm ci" "cd connector && npm ci --no-audit --no-fund"
  step "connector: typecheck" "cd connector && npm run typecheck"
  [ $FAST = 0 ] && { step "connector: build" "cd connector && npm run build" || BUILD_FAILED=1; }
  step "connector: tests" "cd connector && npm test"
fi

if [ $E2E = 1 ]; then
  # Same order as the CI e2e job: connector built, then a fresh SPA build for it to serve.
  step "web: build:local after connector build" "bun run build:local" || BUILD_FAILED=1
  if [ $BUILD_FAILED = 0 ]; then
    step "e2e (playwright)" "bun run e2e"
  else
    skip "e2e (playwright)" "a build failed"
  fi
fi

printf '\n================ gate summary ================\n'
for i in "${!NAMES[@]}"; do
  printf '%-4s  %-42s %6s  %s\n' "${RESULTS[$i]}" "${NAMES[$i]}" "${TIMES[$i]}" "${NOTES[$i]}"
done
printf 'logs: %s\n' "$LOG_DIR"
if [ $FAILED = 0 ]; then
  echo "GATE PASS"
else
  echo "GATE FAIL"
fi
exit $FAILED
