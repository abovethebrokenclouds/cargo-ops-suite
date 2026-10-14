# Cargo Ops connector

The local half of Cargo Ops (plan §3): one Node process on the Windows PC that talks
to Microsoft Flight Simulator through SimConnect, keeps the latest simulator state,
streams it to the browser over a WebSocket on `127.0.0.1:4311`, serves the static web
build and owns the SQLite database.

> **Status: the SimConnect path is untested against MSFS.** Everything here was built and
> tested without a simulator. `--sim fake` (fixture replay) is covered by automated tests,
> and `SimConnectSource` runs against a test-only SimConnect protocol emulator (see
> "Testing without the simulator" below); the real SimConnect handshake, SimVar
> names/units and system events must still be checked on the Windows PC (see
> `docs/VERIFICATION.md`).

## Requirements

- Node.js 24 LTS (22.13 or newer also works; `node:sqlite` needs 22.13+).
- npm (ships with Node). Bun is not needed for the connector.

## Commands (run in `connector/`)

| Command                 | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm ci`                | Install the exact dependency versions from `package-lock.json`.                                         |
| `npm run build`         | Compile to `dist/` (connector + shared protocol + economy) and copy the airport data into `dist/data/`. |
| `npm start -- [flags]`  | Run `dist/connector/src/cli/main.js`.                                                                   |
| `npm run typecheck`     | Type-check sources and tests without emitting.                                                          |
| `npm test`              | Compile sources and tests to `dist-test/` and run them with `node:test`.                                |
| `npm run fixtures:sync` | Copy the web demo fixture into `fixtures/` (never edit the copy by hand).                               |

From the repository root on Windows, `scripts\start-cargo-ops.cmd` does all of this
for you; see `docs/SETUP_WINDOWS.md`.

## CLI

```
--sim simconnect|fake   Data source (default simconnect). fake replays a fixture.
--fixture <path>        Fixture for --sim fake (default fixtures/demo-kmem-katl.jsonl)
--speed <n>             Replay speed multiplier (default 1)
--loop                  Restart the replay when it ends
--record <path>         Append every outgoing frame to a NEW JSONL fixture file
--port <n>              Port on 127.0.0.1 (default 4311; 0 = any free port)
--web <dir>             SPA build to serve (default ../dist/client when present)
--dev-origin [origin]   Also accept this page origin (repeatable); without a value
                        the Vite dev origins http://localhost:8080, http://127.0.0.1:8080
--data-dir <dir>        Config, databases, logs (default below)
--reset-token           Generate a new access token
--backup-keep <n>       Database backups kept in <data-dir>/backups (default 14; 0 = no daily backup)
--open                  Open the browser when ready (start / open / xdg-open)
--verbose               Debug logging
--lan                   Not implemented; refuses to start
--help, --version
```

Examples:

```sh
npm start -- --sim fake --loop --web ../dist/client     # demo replay, cloud/test mode
npm start -- --open --web ../dist/client               # live: waits for MSFS, reconnects
npm start -- --record fixtures/kmem-katl-2026-10-20.jsonl   # record a real flight
```

## Data directory

| OS      | Default                                                  |
| ------- | -------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\CargoOps`                                |
| Others  | `$XDG_CONFIG_HOME/cargo-ops`, else `~/.config/cargo-ops` |

Contents: `config.json` (the access token, 32 random bytes as hex, created on first
run), `cargo-ops.db` (live sessions), `demo.db` (replay sessions; plan §3.2 demo
separation), `logs/connector.log`, `backups/` (P6, below).

## HTTP and WebSocket API

Bound to `127.0.0.1` only. Every request must carry a `Host` header naming the
connector (`127.0.0.1:<port>` or `localhost:<port>`), which blocks DNS rebinding.

| Route                                   | Auth                                                            | Response                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health`                       | none                                                            | `{ ok, version, mode, sim }`                                                                                                                                                                                                                                       |
| `GET /api/session`                      | `Origin` absent or an allowed origin                            | `{ token, wsUrl: "/ws" }`                                                                                                                                                                                                                                          |
| `GET /api/status`                       | `Authorization: Bearer <token>`                                 | health + seq, clients, paths, store stats                                                                                                                                                                                                                          |
| `GET /api/flights`                      | Bearer token                                                    | `{ flights: [...] }`, newest first (≤ 50)                                                                                                                                                                                                                          |
| `GET /api/flights/:id/track`            | Bearer token                                                    | `{ id, points: [{ t, lat, lon, altFt, ... }] }`                                                                                                                                                                                                                    |
| `GET /api/jobs`                         | Bearer token                                                    | jobs domain: `{ boards, available, accepted, aircraft }`                                                                                                                                                                                                           |
| `GET /api/missions`                     | Bearer token                                                    | `{ missions: [...] }`, newest first (≤ 50), with payout breakdowns                                                                                                                                                                                                 |
| `GET /api/ledger?limit&before&category` | Bearer token                                                    | `{ entries, months, cash, startingCash, sum, count, balanced }`: ledger rows newest first (≤ 5,000 per page, `before=<id>` pages back, `category` filters), monthly P&L, and whether Σ amounts = cash − starting cash                                              |
| `GET /api/fleet`                        | Bearer token                                                    | fleet domain (`aircraft`, `selectedId`, `selection`, `ambiguous`, `value`) + `catalogue` (prices, lease rates, tier gates) + the last 200 `events`                                                                                                                 |
| `GET /api/loans`                        | Bearer token                                                    | loans domain (`loans`, `creditScore`, `offers`, debt service, DTI) + `lenders`                                                                                                                                                                                     |
| `GET /api/market`                       | Bearer token                                                    | P5 used market domain (`listings` with known defects only, `generation`, `refreshedGameMs`, `nextRefreshGameMs`); hidden defects never leave the connector                                                                                                         |
| `GET /api/fbos?fbo&limit`               | Bearer token                                                    | P5 part 2 `fbos` domain + the last `limit` (≤ 5,000, default 200) `transactions` (`fboId`, `kind`, `amount`, `source`: own / modelled / sim_ai), optionally of one FBO                                                                                             |
| `GET /api/fbos/quote?icao=`             | Bearer token                                                    | buy price, build cost, land lease, build days and modelled movements/day at an airport (404 unknown airport)                                                                                                                                                       |
| `GET /api/demand`                       | Bearer token                                                    | `demand` domain: airports whose index differs from 1 and the active events                                                                                                                                                                                         |
| `GET /api/logbook`                      | Bearer token                                                    | `{ flights: [...] }` joined with mission, payout, landing grade (≤ 200)                                                                                                                                                                                            |
| `GET /api/export/csv`                   | Bearer token                                                    | logbook CSV download (`text/csv`)                                                                                                                                                                                                                                  |
| `GET /api/export/gpx?flight=<id>`       | Bearer token                                                    | GPX 1.1 track of one flight from the telemetry table                                                                                                                                                                                                               |
| `GET /api/export/json`                  | Bearer token                                                    | JSON career export v4 (company with demand activity and milestones, jobs, missions, ledger, flights, fleet with P5 systems/defects and insurance, loans, aircraft events, used market listings, FBOs, FBO transactions, demand events; no telemetry); v1–v3 import |
| `POST /api/import`                      | Bearer token                                                    | JSON career import (zod-validated, ≤ 32 MB); `409 flight_active` during a flight or mission; the live database refuses replay/demo flights                                                                                                                         |
| `GET /api/backups`                      | Bearer token                                                    | `{ dir, keep, database, backups: [{ name, sizeBytes, createdAt, kind: daily\|manual }], restore: [steps] }`, newest first                                                                                                                                          |
| `POST /api/backups`                     | Bearer token                                                    | on-demand `VACUUM INTO` backup → `201 { backup, removed }`; `409 backup_exists` within the same second                                                                                                                                                             |
| `GET /api/simbrief`                     | Bearer token                                                    | `{ settings: { enabled, username, userId }, plan, endpoint, verified: false }`                                                                                                                                                                                     |
| `PUT /api/simbrief`                     | Bearer token                                                    | update `{ enabled?, username?, userId? }` (strict zod; `400 bad_request`)                                                                                                                                                                                          |
| `POST /api/simbrief/import`             | Bearer token                                                    | fetch the latest OFP → `{ plan }`; `409 simbrief_disabled`/`simbrief_no_user`/`simbrief_busy`, `429 rate_limited` (30 s), `504 simbrief_timeout`, `502 simbrief_unreachable`/`simbrief_error`/`simbrief_invalid`                                                   |
| `DELETE /api/simbrief/plan`             | Bearer token                                                    | forget the planned flight                                                                                                                                                                                                                                          |
| other `/api/*`                          | Bearer token                                                    | `404` JSON                                                                                                                                                                                                                                                         |
| `GET /ws`                               | allowed `Origin` **and** token (`?token=` or the first `hello`) | protocol v1 (below)                                                                                                                                                                                                                                                |
| `GET /*`                                | none                                                            | static SPA; extension-less paths → `_shell.html`                                                                                                                                                                                                                   |

WebSocket session (`packages/protocol`): the client sends `hello` with the token →
`welcome` (`mode: "live"` with SimConnect, `"replay"` with `--sim fake`; `sim.connected`
is true only after node-simconnect's `open()` resolved) → `snapshot` → `delta`/`event`
frames sharing one monotonic `seq`. `resync` returns a fresh snapshot. The server
pings every 15 s. Commands: `flight.start` (needs the aircraft on the ground with the
parking brake set; errors `flight_active`, `no_data`, `not_on_ground`, `brake_not_set`;
with a loaded mission also `not_at_origin` beyond 3 nm, `insufficient_fuel`, `over_mtow`)
and `flight.end` (completed when Arrived; otherwise `not_arrived` unless
`args.abort === true`, which ends it as `aborted`; `no_flight` without one). Cargo
commands (P3, see `docs/ECONOMY.md`): `jobs.list`, `jobs.refresh {airport?, destination?}`,
`job.accept {jobId}`, `job.release {jobId}`, `mission.load {jobIds}`, `mission.unload`,
`mission.abort`, `settings.update {aircraftType?: key | null, base?}`; errors include
`bad_args`, `unknown_airport`, `job_unavailable`, `job_not_accepted`, `job_loaded`,
`mixed_route`, `payload_exceeded`, `runway_unsuitable`, `out_of_range`, `mission_active`,
`no_mission`, `mission_in_progress`, `unknown_type`. Every other command is answered with
`ok: false, error.code: "not_implemented"`. When the simulator connects or disconnects, every client receives a
new `welcome` + `snapshot`, and simulator-derived domains are cleared on disconnect so
stale values never look live. Close codes: `4401` bad/missing token, `4400` invalid
first message, `4408` no hello within 5 s.

## Flight tracking (plan §6.2–§6.4)

`src/core/flight-core.ts` runs three pure, deterministic modules on every motion
update and publishes their results through the store (it is the only producer of
the `phase` and `flight` domains and of `phase.changed`, `touchdown`,
`flight.started` and `flight.ended`):

- `phase-fsm.ts`: Boarding → TaxiOut (GS > 5 kt for 3 s) → Takeoff (airborne, GS > 30)
  → Climb (VS > +300 fpm for 30 s) → Cruise (|VS| < 300 for 30 s) → Descent
  (VS < −300 for 30 s) → Approach (AGL < 3,000 ft and VS < −100 for 10 s) → Landing
  (debounced ground contact) → TaxiIn (GS < 30) → Arrived (engines off, brake set).
  Climb/Cruise/Descent move among themselves; Approach → Climb is a go-around;
  Landing/TaxiIn → Climb (airborne, VS > +300 for 30 s) is a touch-and-go; Arrived →
  TaxiOut starts the next leg. On-ground changes need 3 consecutive samples.
- `landing-analyser.ts`: rate from `PLANE TOUCHDOWN NORMAL VELOCITY` when the sim
  reports a fresh value (`rateSource: "touchdownVelocity"`), else the last airborne
  `VERTICAL SPEED` (`"verticalSpeed"`); peak G within 800 ms; bounces (AGL > 35 ft then
  < 5 ft); grade from `packages/protocol/src/landing.ts`.
- `flight-tracker.ts`: great-circle distance at ≤ 1 Hz from block-out, teleport flag
  when a jump exceeds GS × Δt × 3 + 0.05 nm (not counted), block/airborne time on the
  sim clock (stopped while paused), `noBonus` above 1×, `invalidated` above 8×, crash →
  status `failed`.

Time: frames carry no simulator time, so the core uses the receive clock × sim rate,
stopped while paused. A replay that compresses time states it in `sim.simTimeSec`
(the synthetic demo fixture does), and the core uses that instead. FakeSource passes
each frame's recorded `t` as the receive clock, so `--speed` never changes the result.

FakeSource strips the `phase`/`flight` domains and the four derived events from any
fixture, so the connector recomputes them from raw telemetry.

Flights (`flights` table; `summary_json` added by migration 2) and telemetry
(`telemetry` table: 1 Hz, plus 5 Hz for the 60 s before each touchdown) are written
to the database of the session's mode: `demo.db` for replays, `cargo-ops.db` live.

## Cargo operations (P3)

`src/core/economy/engine.ts` owns the `company`, `jobs` and `mission` domains and the
`mission.started`, `mission.delivered`, `mission.failed` and `job.completed` events. It
observes the flight core through hooks: start at the origin (3 nm), leg verification at
Arrived (≥ 90 % of the great circle, parked within 3 nm of the destination, no teleport,
not invalidated), payout with a full breakdown, crash → failed. Its domains survive a
replay restart (they are merged into the reset snapshot). Boards are seeded from the
company seed (fixed for a new demo/replay company, random for a new live one). Formulas
and constants: `docs/ECONOMY.md`.

Airport data: the job generator needs the bundled OurAirports subset (public domain,
large + medium airports with longest runway and surface). `npm run build` (and
`npm test`) copy `../src/assets/data/airports-major.json` into `dist/data/` with
`scripts/copy-data.mjs`, so a built connector is self-contained; at runtime the loader
looks for `data/airports-major.json` next to the build and falls back to the repository
file. Without it the connector still runs, with job boards disabled (logged).

Storage (migration 3): `missions`, `mission_jobs`, `ledger` (category `job_payout`, renamed `mission_payout` in P4;
P4 extends it), `jobs.created_at`/`mission_id`; the company record lives in the v1
`company` table. Replays write `demo.db`, live sessions `cargo-ops.db`.

## Company, fleet and loans (P4)

The same engine runs the shared `CompanyBook` (`packages/economy/src/book.ts`) and
publishes the `fleet`, `loans` and `ledger` domains plus the P4 `company` fields (tier
name, credit score, net worth, debt, company clock). Every cash change is a ledger row
with a running balance. Commands (all return `{ ok:false, error:{ code, message } }` on
refusal):

| Command        | Args                                                                        | Refusal codes                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet.buy`    | `{ typeKey, airport?, financing?: { lenderId, termMonths, principal } }`    | `bad_args`, `unknown_type`, `reputation_gate`, `unknown_airport`, `unknown_lender`, `credit_score_too_low`, `ltv_exceeded`, `bad_term`, `insufficient_cash`                      |
| `fleet.sell`   | `{ aircraftId }`                                                            | `unknown_aircraft`, `not_owned`, `aircraft_busy`, `aircraft_on_mission`, `underwater`                                                                                            |
| `fleet.lease`  | `{ typeKey, kind: "dry" \| "wet", airport? }`                               | `unknown_type`, `reputation_gate`, `unknown_airport`, `insufficient_cash`                                                                                                        |
| `fleet.return` | `{ aircraftId }`                                                            | `unknown_aircraft`, `not_leased`, `aircraft_busy`, `aircraft_on_mission`, `insufficient_cash`                                                                                    |
| `fleet.repair` | `{ aircraftId }`                                                            | `unknown_aircraft`, `aircraft_busy`, `aircraft_on_mission`, `no_wear`, `insufficient_cash`                                                                                       |
| `fleet.select` | `{ aircraftId \| null }` (null = back to TITLE auto-match)                  | `unknown_aircraft`, `mission_active`                                                                                                                                             |
| `loan.quote`   | `{ principal, termMonths, lenderId?, collateralValue?, collateral? }`       | returns `{ quotes: [...] }`, each with `ok` and a `code`                                                                                                                         |
| `loan.take`    | `{ lenderId, principal, termMonths, collateral: { type: "aircraft", id } }` | `unsupported_collateral`, `not_owned`, `collateral_encumbered`, `reputation_gate`, `credit_score_too_low`, `declined_after_default`, `bad_term`, `bad_principal`, `ltv_exceeded` |
| `loan.payoff`  | `{ loanId }`                                                                | `unknown_loan`, `insufficient_cash`                                                                                                                                              |

`mission.load` now also needs the selected fleet aircraft (`no_aircraft`,
`aircraft_ambiguous`, `aircraft_busy`, `aircraft_in_maintenance`,
`aircraft_unairworthy`, `aircraft_not_at_origin`). Events: `loan.payment`,
`loan.missed`, `aircraft.repossessed`, `repair.completed`.

Company clock: `startConnector` ticks `economy.tick()` every second
(`clockIntervalMs`, 0 disables it in tests); in-game time = max(wall Δ ≤ 60 s,
simulator Δ). Storage: migration 4 (`fleet`, `aircraft_events`, `loans`,
`ledger.balance`/`game_at`). Formulas: `docs/ECONOMY.md` (P4).

## Used aircraft and airworthiness (P5, part 1)

The book adds per-system condition and defects, the airworthiness gate, maintenance
orders on the company clock and a seeded used market (formulas: `docs/ECONOMY.md`, P5).
`mission.load` and an explicit `flight.start` (with a loaded mission, or without one when
the selected aircraft is parked where the sim is) first let hidden defects surface, then
refuse with `aircraft_unairworthy` and `error.reasons` (`grounding_defect`,
`minor_not_deferred`, `deferral_expired`, `system_below_minimum`, `annual_due`); a
loaded aircraft with a ferry permit is refused with `ferry_only`. A flight without a
mission by the selected aircraft holding a permit, from the permit origin, is a ferry
(fuel, landing fee and wear booked as `ferry`, no revenue). Fuel quantity reaching
`max(1 lb, 0.5 % of block-out fuel)` in flight counts as dry tanks.

| Command              | Args                        | Refusal codes                                                                                                                                                                                   |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market.refresh`     | `{}`                        | `no_airport_data`                                                                                                                                                                               |
| `market.inspect`     | `{ listingId }`             | `unknown_listing`, `already_inspected`, `insufficient_cash`                                                                                                                                     |
| `market.buy`         | `{ listingId, financing? }` | `unknown_listing`, `unknown_type`, `reputation_gate`, `unknown_lender`, `credit_score_too_low`, `ltv_exceeded`, `bad_term`, `insufficient_cash`                                                 |
| `fleet.repairDefect` | `{ aircraftId, defectId }`  | `unknown_aircraft`, `aircraft_busy`, `aircraft_on_mission`, `unknown_defect`, `already_queued`, `insufficient_cash`                                                                             |
| `fleet.repairAll`    | `{ aircraftId }`            | `unknown_aircraft`, `aircraft_busy`, `aircraft_on_mission`, `no_defects`, `insufficient_cash`                                                                                                   |
| `fleet.annual`       | `{ aircraftId }`            | `unknown_aircraft`, `aircraft_busy`, `aircraft_on_mission`, `already_queued`, `insufficient_cash`                                                                                               |
| `fleet.ferryPermit`  | `{ aircraftId }`            | `unknown_aircraft`, `aircraft_busy`, `aircraft_on_mission`, `permit_active`, `ferry_not_allowed`, `at_maintenance_airport`, `ferry_out_of_range`, `no_maintenance_airport`, `insufficient_cash` |
| `fleet.defer`        | `{ aircraftId, defectId }`  | `unknown_aircraft`, `unknown_defect`, `not_deferrable`, `already_deferred`                                                                                                                      |

Events: `defect.found`, `inspection.completed` (pre-purchase or annual),
`aircraft.grounded` (also on a write-off). Domains: `market` (new) and P5 fields on every
fleet aircraft (`systems`, `airworthiness`, `annual`, `ferryPermit`, `maintenance`,
`repairAllCost/Hours`, `ageYears`) plus the fleet `maintenance` board. Storage:
migration 5 (`market_listings`; P4 fleet rows normalised on load). `EconomyOptions.maintenance`
injects the `MaintenanceCapability` (default: large airports; the FBO lane extends it).

## FBOs, demand, insurance and milestones (P5, part 2)

Formulas: `docs/ECONOMY.md` (P5 — FBOs, demand, insurance, milestones). FBO modelled traffic
accrues hour by hour on the company clock and is booked once per in-game day; own arrivals at
an FBO airport book fuel at the farm's cost and waive the landing fee; boards include local
demand and an own cargo terminal (`job.demandFactor`). With a live simulator,
`src/sim/ai-traffic.ts` samples AI aircraft near owned FBO airports every 30 s
(`requestDataOnSimObjectType`, AIRCRAFT, radius around the user aircraft ≤ 200 km) and
credits each observed landing as a `sim_ai` bonus — unverified on a real sim.

| Command              | Args                                          | Refusal codes                                                                                                              |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fbo.buy`            | `{ icao, financing? }`                        | `unknown_airport`, `fbo_exists`, `unknown_lender`, `credit_score_too_low`, `ltv_exceeded`, `bad_term`, `insufficient_cash` |
| `fbo.build`          | `{ icao, financing? }`                        | as `fbo.buy`                                                                                                               |
| `fbo.sell`           | `{ fboId }`                                   | `unknown_fbo`, `fbo_building`, `underwater`                                                                                |
| `fbo.module.buy`     | `{ fboId, module }`                           | `unknown_fbo`, `fbo_building`, `module_installed`, `module_pending`, `insufficient_cash`                                   |
| `fbo.module.upgrade` | `{ fboId, module }`                           | `unknown_fbo`, `fbo_building`, `module_not_installed`, `module_max_level`, `module_pending`, `insufficient_cash`           |
| `fbo.pricing`        | `{ fboId, fuelPriceRatio?, handlingFeeUsd? }` | `bad_args` (ratio 0.7–1.5, fee $20–$300), `unknown_fbo`                                                                    |
| `insurance.buy`      | `{ aircraftId }`                              | `unknown_aircraft`, `not_owned`, `already_insured`, `insufficient_cash`                                                    |
| `insurance.cancel`   | `{ aircraftId }`                              | `unknown_aircraft`, `not_insured`                                                                                          |

`module` is one of `fuel`, `hangar`, `maintenance`, `cargo`, `ramp`. Loans also accept
`collateral: { type: "fbo", id }`. Events: `fbo.income` (day close per FBO, own arrival,
sim AI), `fbo.built` (construction or module done), `demand.event`, `milestone.reached`,
`insurance.claim`. Domains: `fbos`, `demand` (new), `insurance` on owned fleet aircraft,
`milestones` on the company. Storage: migration 6 (`fbos`, `fbo_modules`,
`fbo_transactions`, `demand_events`, `demand_index`, `insurance_policies`, `milestones`).

## Backups, SimBrief and packaging (P6)

`src/storage/backups.ts`: `VACUUM INTO <data-dir>/backups/<db>-YYYYMMDD.db` at start and then
hourly when today's file is missing (live database only), on-demand
`<db>-YYYYMMDD-HHMMSS.db` through `POST /api/backups`, then rotation to the newest
`--backup-keep` files of that database (`<db>` is `cargo-ops` or `demo`). Restore is manual
with the connector stopped (docs/SETUP_WINDOWS.md §6).

`src/core/simbrief.ts`: optional SimBrief OFP import, off by default. The player's username or
pilot ID is kept in the `settings` table; `POST /api/simbrief/import` fetches
`https://www.simbrief.com/api/xml.fetcher.php?(userid|username)=…&json=1` with a
`CargoOps/<version>` User-Agent, one request at a time, at most one per 30 s, 10 s timeout,
no retries, and maps it with `packages/protocol/src/simbrief.ts` (tested against the
HAND-MADE `fixtures/simbrief-ofp.handmade.json`; unverified against a real OFP). The username
is never logged.

Packaging: no single-file executable is built — that would bundle `node-simconnect`
(LGPL-3.0-or-later); it stays an unmodified module in `node_modules`. The supported launcher
is `scripts\start-cargo-ops.cmd`; `scripts\create-shortcut.ps1` adds Start-menu, desktop and
startup shortcuts.

## Protocol sharing

The connector uses the exact zod schemas from `packages/protocol/src` without
copying them and without anything installed at the repository root:

- `tsconfig.json` sets `rootDir: ".."` and includes `../packages/protocol/src/**/*.ts`
  (tests excluded). The output mirrors the repository: `dist/connector/src/...` and
  `dist/packages/protocol/src/...`, both inside `connector/`.
- The connector compiles to CommonJS (`module: commonjs`, `moduleResolution: node10`),
  so the protocol's extension-less relative imports (`./messages`) resolve at runtime.
- `paths: { "zod": ["./node_modules/zod"] }` makes the type checker use the
  connector's own zod even for files under `packages/`. At runtime,
  `require("zod")` from `dist/packages/protocol/src/*.js` walks up to
  `connector/node_modules/zod`.
- `src/protocol.ts` is the single import point (`export * from "../../packages/protocol/src/index"`).

`zod` is pinned to the same version as the web app (3.25.76). If the web app moves to
another zod version, update `connector/package.json` in the same change.

## Layout

```
connector/
  src/sim/       SimSource interface, SimConnectSource, FakeSource,
                 simvars.ts (THE SimVar table), mapping.ts (pure raw → domain functions)
  src/core/      StateStore (snapshot/delta/seq), ConnectorSession (welcome, link),
                 Recorder (JSONL), config (data dir, token), logger,
                 economy/ (job boards, missions, airport data loader)
  src/storage/   node:sqlite adapter (WAL, migrations; schema from plan §3.3)
  src/server/    node:http + ws server, origin/host/token checks, static serving
  src/cli/       argument parsing, app composition, main entry point
  test/          node:test suites (compiled to dist-test/)
  fixtures/      replay fixtures (demo-kmem-katl.jsonl is SYNTHETIC; see fixtures/README.md)
  scripts/       clean.mjs, sync-fixtures.mjs, copy-data.mjs
```

## SimConnect notes (unverified until tested on the PC)

- `open("Cargo Ops", Protocol.SunRise)` first, then `Protocol.KittyHawk`; on failure it
  retries with backoff (2 s doubling to 30 s) and reconnects after `quit`/`close`/`error`.
- node-simconnect finds the simulator by itself: `SimConnect.cfg` in the working or
  home directory, else the named pipe, else the port from the registry.
- Data definitions come from `src/sim/simvars.ts`: a `counts` request once per aircraft
  (`NUMBER OF ENGINES`, `PAYLOAD STATION COUNT`, capped at 4 engines / 20 stations), a
  1 Hz `slow` definition and a per-sim-frame `fast` definition throttled to 5 Hz
  (10 Hz below 1,000 ft AGL). If the sim rejects a SimVar, the exception is logged with
  its name, the entry is dropped and the definition rebuilt; dependent domains are then
  simply not reported.
- Entries marked `verified: false`: `SIMULATION RATE`, `PAYLOAD STATION WEIGHT`/`NAME`
  units, `ENG FUEL FLOW PPH`, `IS ON GROUND` (falls back to `SIM ON GROUND`),
  `PLANE TOUCHDOWN NORMAL VELOCITY` (ft/s, ×60; sign taken as unknown, the analyser
  uses its magnitude) and `PLANE TOUCHDOWN BANK/PITCH DEGREES` (fast definition).
- System events: `Pause`, `Pause_EX1`, `SimStart`, `SimStop`, `FlightLoaded`,
  `AircraftLoaded`, `Crashed`, `CrashReset`, `1sec`; `requestSystemState("Sim")` on connect.
- The `sim` domain is only sent once a real `SIMULATION RATE` arrives (the schema needs
  it); until then the chip relies on `welcome.sim`.
- AI traffic (`requestDataOnSimObjectType`, AIRCRAFT) skips the user aircraft's own object
  id (taken from the user-aircraft frames) in case the request returns it.

## Testing without the simulator

`test/support/simconnect-emulator.ts` is a TEST-ONLY TCP server that speaks the SimConnect
wire format (written from the MSFS SDK documentation; no node-simconnect code is copied):
OPEN with `SunRise` (MSFS 2024) or `KittyHawk` (MSFS 2020) profiles, data definitions and
requests (FLOAT32/64, INT32/64, fixed and variable strings), `RECV_EXCEPTION` for SimVars in
a reject list, system events, system state, by-type AI requests, dropped connections and
`RECV_QUIT`. `test/simconnect-emulator.test.ts` drives the real `SimConnectSource` and the
real CLI against it. It proves the wire format and our handling of it, not what MSFS
sends; results are recorded as "Emulated" evidence, never as PC checks.

The CLI accepts two hidden options for it (also usable with a SimConnect IPv4 listener
configured in `SimConnect.xml`): `--simconnect-host <host> --simconnect-port <port>`
connect over TCP instead of the normal discovery. Without them nothing changes.

## Licensing

`node-simconnect` is LGPL-3.0-or-later. It is an ordinary, unmodified runtime
dependency installed into `node_modules` (its LICENSE ships there) and is never
bundled or copied. See `docs/ASSET_INVENTORY.md` for every dependency and license.
