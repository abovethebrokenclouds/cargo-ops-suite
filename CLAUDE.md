# Cargo Ops — notes for Claude Code

Read `AGENTS.md` first (Lovable notice and project notes). Plan: `docs/CARGO_OPS_PLAN.md`.
Evidence record: `docs/VERIFICATION.md`. Dependency/asset licenses: `docs/ASSET_INVENTORY.md`.

## Gate

```sh
bash scripts/gate.sh          # full pre-push gate, same checks as CI, PASS/FAIL summary
bash scripts/gate.sh --fast   # lint, typecheck, inventory, unit tests (no builds, no e2e)
bash scripts/gate.sh --web    # or --connector: one side only
```

Cloud sessions install dependencies via `.claude/hooks/session-start.sh`. Never run
`playwright install`; the preinstalled Chromium is used through `PW_CHROMIUM_PATH`.

## Hard rules

- Zero cost, open source; no API keys, accounts or trials. Prefer no new dependency; any new
  one needs a verified license and a row in `docs/ASSET_INVENTORY.md` first.
- `node-simconnect` (LGPL-3.0) stays unmodified and unbundled.
- Never fabricate telemetry; never show connected without a real welcome; every frame carries
  `source: "sim" | "replay" | "demo"`.
- Token-only styling (`src/styles.css`); no runtime CDN fonts.
- Both builds stay green: `bun run build` and `bun run build:local`.
- No AI model names or identifiers in code, docs or commit messages.
- `docs/VERIFICATION.md`: a simulator-facing PC row is ✅ only after the owner verified it on a
  Windows PC with MSFS; cloud evidence goes in the cloud table.
- Kill processes with `ps` + `kill <PID>`, never `pkill -f`.

## Merge policy

Lovable is connected: never force-push, rebase, amend or squash pushed commits, and never
force-push `main`. Work on `claude/<slug>` branches and merge with merge commits only.

## Team

`.claude/agents/`: `cargo-builder` (implements in a worktree, runs the gate),
`cargo-verifier` (adversarial re-verification of a branch), `cargo-ci-fixer` (fixes red
GitHub Actions from the logs, never by skipping tests).
