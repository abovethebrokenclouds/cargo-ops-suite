# Cargo Ops — Verification Record

Two tables, per the plan (§10). A feature is only called complete when its
row in the second table is green. "Cloud CI" means the GitHub Actions workflow
in `.github/workflows/ci.yml` or the same commands run in a cloud container
with no simulator. Nothing in the first table proves anything about a real
MSFS connection.

Status legend: ✅ passed · ⏳ not yet run · ❌ failed · — not applicable yet.

## Verified in cloud CI

| Date       | Commit / PR            | Check                                                                                                                                                                                                                          | Result | Notes                                                          |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------- |
| 2026-10-13 | `85576d5` (PR #2)      | GitHub Actions `web` job: lint, typecheck, inventory, vitest, default build, local build, no-CDN-font guard                                                                                                                    | ✅     | first green CI run                                             |
| 2026-10-13 | P0 integration (PR #2) | lint, typecheck, inventory, vitest (137 tests), `build`, `build:local`                                                                                                                                                         | ✅     | cloud container                                                |
| 2026-10-13 | P0 integration (PR #2) | Chromium (dev server): all 9 routes render, chip reads `DEMO DATA` from DemoTransport, no external requests, no console errors                                                                                                 | ✅     | Playwright script, not yet a committed E2E spec                |
| 2026-10-13 | P0 integration (PR #2) | Chromium with `VITE_CARGO_OPS_CONNECTOR=1` and no connector: chip reads `CONNECTOR OFFLINE`, no fallback to demo data                                                                                                          | ✅     | only console error is the failed `/api/session` fetch          |
| 2026-10-13 | L3 branch              | connector: `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (60 node:test cases) on Node 22.22, Linux                                                                                                                | ✅     | cloud container; SimConnect code type-checked only             |
| 2026-10-13 | L3 branch              | connector build + tests with no root `node_modules` (protocol compiled from `packages/protocol`, zod from `connector/node_modules`)                                                                                            | ✅     | copy of connector + packages in a scratch dir                  |
| 2026-10-13 | L3 branch              | FakeSource over a real WebSocket: hello → welcome(`replay`, `connected:false`) → snapshot → deltas/events with contiguous seq; resync; ping/pong; commands → `not_implemented`                                                 | ✅     | `connector/test/server.test.ts`                                |
| 2026-10-13 | L3 branch              | Security: foreign/missing Origin on `/ws` → 403; wrong query token → 401; wrong/missing hello token → close 4401/4400; `/api/session` cross-origin → 403; foreign Host → 421; `/api/*` without bearer → 401                    | ✅     | `connector/test/server.test.ts`                                |
| 2026-10-13 | L3 branch              | Static serving: SPA shell fallback, content types, security headers, 12 traversal/dotfile attempts refused                                                                                                                     | ✅     | `connector/test/server.test.ts`                                |
| 2026-10-13 | L3 branch              | `node:sqlite` storage: §3.3 schema, WAL, idempotent migrations, demo.db vs cargo-ops.db                                                                                                                                        | ✅     | works on Node 22.22 without a flag                             |
| 2026-10-13 | L3 branch              | `--record` writes JSONL that `parseFixture` accepts and FakeSource replays                                                                                                                                                     | ✅     | unit test + manual run (42 frames)                             |
| 2026-10-13 | L3 branch              | SimVar table + pure mapping functions (raw values → domains), definition-order buffer reader                                                                                                                                   | ✅     | hand-made inputs only; not real sim data                       |
| 2026-10-13 | L3 branch              | root `bun run lint`, `typecheck`, `check:inventory`, `test`, `build`, `build:local` with connector present                                                                                                                     | ✅     | connector excluded from root tsc/vitest; linted by root eslint |
| 2026-10-13 | L3 branch              | Smoke: built connector `--sim fake --loop --web ../dist/client --port 4311`; `/api/health`, `/api/session`; Chromium chip reads `REPLAY`, `data-status="replay"` on `/` and `/flight`, no console errors, no external requests | ✅     | Playwright script outside the repo                             |
| 2026-10-13 | L3 branch              | GitHub Actions `connector` job (ubuntu-latest + windows-latest, Node 24)                                                                                                                                                       | ⏳     | runs on the next push/PR                                       |

## Requires Windows PC with MSFS

These rows can only be checked by the owner on the Windows PC. Each starts ⏳.

| Item                                                                                                                                                          | Plan ref    | Status | Date | Notes |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | ---- | ----- |
| `scripts\start-cargo-ops.cmd` end-to-end on a clean clone: Node check, `npm ci`, SPA build (bun or npm path), connector build, browser opens `127.0.0.1:4311` | §11, P1     | ⏳     | —    | —     |
| Connector `npm ci` / `npm run build` / `npm test` on Windows with Node 24 LTS                                                                                 | P1          | ⏳     | —    | —     |
| Real SimConnect handshake with MSFS 2024 (`SunRise`), chip shows "LIVE · MSFS 2024 · SunRise"                                                                 | §6, §11.4   | ⏳     | —    | —     |
| Real SimConnect handshake with MSFS 2020 (`KittyHawk` fallback), chip shows "LIVE · MSFS 2020 · KittyHawk"                                                    | §6          | ⏳     | —    | —     |
| Simulator name derived from `RecvOpen.applicationName` is correct for 2020 and 2024                                                                           | §6          | ⏳     | —    | —     |
| Pipe discovery from registry without `SimConnect.xml`/`SimConnect.cfg`                                                                                        | §11         | ⏳     | —    | —     |
| Data definitions return sane values: no `SimConnect rejected` lines in `connector.log`; counts (engines, payload stations) match the aircraft                 | §6.1        | ⏳     | —    | —     |
| Telemetry values match the sim (alt, AGL, IAS, TAS, GS, heading, VS, G, on-ground)                                                                            | §6.1        | ⏳     | —    | —     |
| Fuel quantity/weight, per-engine fuel flow, weights, payload stations, engines, parking brake match the sim                                                   | §6.1, §14.2 | ⏳     | —    | —     |
| Fast data rate ≈5 Hz in flight and ≈10 Hz below 1,000 ft AGL (Diagnostics)                                                                                    | §3.2        | ⏳     | —    | —     |
| Pause / Pause_EX1 / sim-rate events reported correctly                                                                                                        | §6.1, §14.4 | ⏳     | —    | —     |
| `SIMULATION RATE`, `PAYLOAD STATION *` units, fuel-flow SimVars, `IS ON GROUND` on 2020 confirmed                                                             | §14.12      | ⏳     | —    | —     |
| Reconnect: quit and restart MSFS while the connector runs; chip goes SIM OFFLINE → LIVE without restarting the connector                                      | §6          | ⏳     | —    | —     |
| Aircraft change (AircraftLoaded/FlightLoaded) re-reads engine and station counts                                                                              | §6.1        | ⏳     | —    | —     |
| First real JSONL fixture recorded with `--record`, replays with `--sim fake --fixture`, committed                                                             | P1          | ⏳     | —    | —     |
| Facilities requests (nearby airports) on 2024                                                                                                                 | §6.1, §14.3 | ⏳     | —    | —     |
| No firewall prompt on loopback bind                                                                                                                           | §14.11      | ⏳     | —    | —     |
| Landing analyser grade matches a real touchdown                                                                                                               | §6.3        | ⏳     | —    | —     |
| Full mission accept → fly → deliver on the sim                                                                                                                | P3          | ⏳     | —    | —     |
| PWA install from Edge/Chrome                                                                                                                                  | P6          | ⏳     | —    | —     |
