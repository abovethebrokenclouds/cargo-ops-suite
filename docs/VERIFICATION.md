# Cargo Ops — Verification Record

Two tables, per the plan (§10). A feature is only called complete when its
row in the second table is green. "Cloud CI" means the GitHub Actions workflow
in `.github/workflows/ci.yml` or the same commands run in a cloud container
with no simulator. Nothing in the first table proves anything about a real
MSFS connection.

Status legend: ✅ passed · ⏳ not yet run · ❌ failed · — not applicable yet.

## Verified in cloud CI

| Date       | Commit / PR            | Check                                                                                                                          | Result | Notes                                                 |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------- |
| 2026-10-13 | `85576d5` (PR #2)      | GitHub Actions `web` job: lint, typecheck, inventory, vitest, default build, local build, no-CDN-font guard                    | ✅     | first green CI run                                    |
| 2026-10-13 | P0 integration (PR #2) | lint, typecheck, inventory, vitest (137 tests), `build`, `build:local`                                                         | ✅     | cloud container                                       |
| 2026-10-13 | P0 integration (PR #2) | Chromium (dev server): all 9 routes render, chip reads `DEMO DATA` from DemoTransport, no external requests, no console errors | ✅     | Playwright script, not yet a committed E2E spec       |
| 2026-10-13 | P0 integration (PR #2) | Chromium with `VITE_CARGO_OPS_CONNECTOR=1` and no connector: chip reads `CONNECTOR OFFLINE`, no fallback to demo data          | ✅     | only console error is the failed `/api/session` fetch |

## Requires Windows PC with MSFS

These rows can only be checked by the owner on the Windows PC. Each starts ⏳.

| Item                                                                                   | Plan ref    | Status | Date | Notes |
| -------------------------------------------------------------------------------------- | ----------- | ------ | ---- | ----- |
| Connector starts with `scripts\start-cargo-ops.cmd`, browser opens on `127.0.0.1:4311` | §11         | ⏳     | —    | —     |
| Real SimConnect handshake with MSFS 2024 (`SunRise`), chip shows "LIVE · MSFS 2024"    | §6, §11.4   | ⏳     | —    | —     |
| Real SimConnect handshake with MSFS 2020 (`KittyHawk` fallback)                        | §6          | ⏳     | —    | —     |
| Pipe discovery from registry without `SimConnect.xml`                                  | §11         | ⏳     | —    | —     |
| Telemetry values match the sim (alt, IAS, GS, heading, VS, fuel)                       | §6.1        | ⏳     | —    | —     |
| Pause / sim-rate events reported correctly                                             | §6.1, §14.4 | ⏳     | —    | —     |
| `SIMULATION RATE`, `PAYLOAD STATION *` units, fuel-flow SimVars confirmed              | §14.12      | ⏳     | —    | —     |
| First real JSONL fixture recorded with `--record` and committed                        | P1          | ⏳     | —    | —     |
| Facilities requests (nearby airports) on 2024                                          | §6.1, §14.3 | ⏳     | —    | —     |
| No firewall prompt on loopback bind                                                    | §14.11      | ⏳     | —    | —     |
| Landing analyser grade matches a real touchdown                                        | §6.3        | ⏳     | —    | —     |
| Full mission accept → fly → deliver on the sim                                         | P3          | ⏳     | —    | —     |
| PWA install from Edge/Chrome                                                           | P6          | ⏳     | —    | —     |
