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
--weather online|sample|off
                        METAR source (default online with simconnect, sample with fake)
--open                  Open the browser when ready (start / open / xdg-open)
--verbose               Debug logging
--lan [address]         LAN opt-in: also listen on 0.0.0.0 or one IPv4 of this PC
                        (pairing required, see "LAN access" below)
--no-lan                Stay on 127.0.0.1 even if LAN access is saved as on
--panel-frame-ancestor <source>
                        Also let this origin or scheme frame the read-only /panel page
                        (repeatable; "any" lifts it for /panel only). Default: 'self' coui:
                        (the in-sim toolbar panel, msfs-panel/); every other path is never
                        framable (X-Frame-Options DENY, frame-ancestors 'none')
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
run, and the saved LAN opt-in `lan: { enabled, address }`), `lan-devices.json` (paired LAN
devices: id, name, SHA-256 of the device token, paired at/from), `cargo-ops.db` (live sessions), `demo.db` (replay sessions; plan §3.2 demo
separation), `logs/connector.log`, `backups/` (P6, below).

## HTTP and WebSocket API

Bound to `127.0.0.1` only unless LAN access is on (below). Every request must carry a
`Host` header naming the connector (`127.0.0.1:<port>`, `localhost:<port>`, or with LAN on an
IPv4 literal of a bound interface with the port), which blocks DNS rebinding.

### LAN access (opt-in)

Off by default. `--lan` (or the setting saved from `/settings` via `PUT /api/lan/settings`,
applied on the next start; `--no-lan` overrides it) listens on `0.0.0.0`, or with
`--lan <IPv4>` on `127.0.0.1` plus that one address. An address that is not this PC's is
refused at start when it comes from the command line (the message names `--lan` and
`--no-lan`); a saved address that left this PC (DHCP) logs a warning, stays on `127.0.0.1` and
is reported as `warning` in `GET /api/lan`. The Host/Origin allowlist grows by `http://<bound IPv4>:<port>` only; with `0.0.0.0` the
interface list is re-read at most every 5 s when an unknown IP Host arrives (DHCP).

- The main token is **loopback-only**: `GET /api/session` gives it only to a loopback client,
  and it is refused on `/api/*` and `/ws` from any other address.
- A LAN client pairs: `POST /api/lan/code` on this PC creates a one-time code (8 characters
  from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 5 min, single use; a new code replaces the old one);
  `POST /api/lan/pair { code, name }` from the LAN page (connector Origin required) returns a
  separate 32-byte device token. Five wrong codes from one address within 15 min lock it out
  for 15 min (`429 pairing_locked` + `Retry-After`); ten wrong codes in total burn the code
  (logged at warn, `codeBurned: true` in `GET /api/lan` until a new code). Device names lose
  Unicode control (Cc) and format (Cf: bidi overrides, zero-width) characters.
- A paired device sends its token to `GET /api/session` (Bearer) to get it confirmed, or gets
  `403 pairing_required`. It has full control (`/api/*` reads, all WebSocket commands) except
  the local-only routes: `POST /api/import`, `GET`/`POST /api/backups` (the list and restore
  steps carry paths), every `DELETE`, and `/api/lan*` → `403 local_only`. Its `/api/status`
  omits the path fields `dataDir`, `database` and `recording`.
- A WebSocket opened with `?token=` is bound to that identity (this PC, or one device): a
  `hello` resolving to another identity is closed with `4401`.
- Revoking (`DELETE /api/lan/devices/:id`) closes that device's sockets with `4401`.
  `--reset-token` forgets every device. Pairing, failures and revokes are logged.

| Route                                   | Auth                                                            | Response                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health`                       | none                                                            | `{ ok, version, mode, sim }`                                                                                                                                                                                                                                       |
| `GET /api/session`                      | `Origin` absent or an allowed origin                            | loopback: `{ token, wsUrl: "/ws", scope: "local" }`; LAN client with a valid device token (Bearer): `{ token, wsUrl, scope: "lan", device }`; other LAN clients `403 pairing_required`                                                                             |
| `POST /api/lan/pair`                    | LAN on, connector `Origin`, no token                            | `{ code, name }` → `{ token, wsUrl, scope: "lan", device }`; `401 invalid_code`, `429 pairing_locked`, `404 lan_off`                                                                                                                                               |
| `GET /api/lan`                          | main token (this PC only)                                       | `{ active, bind, port, urls, interfaces, setting, restartRequired, code, devices }`                                                                                                                                                                                |
| `POST`/`DELETE /api/lan/code`           | main token (this PC only)                                       | new one-time pairing code (`409 lan_off` when LAN is off) / cancel it                                                                                                                                                                                              |
| `PUT /api/lan/settings`                 | main token (this PC only)                                       | `{ enabled, address? }` saved for the next start (`400 bad_address`)                                                                                                                                                                                               |
| `DELETE /api/lan/devices/:id`           | main token (this PC only)                                       | revoke a paired device (`404 unknown_device`)                                                                                                                                                                                                                      |
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
| `GET /api/pilots`                       | Bearer token                                                    | `pilots` domain (`simulated: true`): hired pilots, their routes, monthly P&L and last legs, the served airports and the route options; simulated economy, never telemetry                                                                                          |
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
| `GET /api/weather/metar?ids=&online=`   | Bearer token                                                    | `{ mode, onlineAllowed, stations: [{ station, report, note }], attribution, endpoint }` for 1–8 ICAO ids (`400 bad_request` otherwise); `online=1` is the page's switch, without it nothing is fetched                                                             |
| other `/api/*`                          | Bearer token                                                    | `404` JSON                                                                                                                                                                                                                                                         |
| `GET /ws`                               | allowed `Origin` **and** token (`?token=` or the first `hello`) | protocol v1 (below)                                                                                                                                                                                                                                                |
| `GET /*`                                | none                                                            | static SPA; extension-less paths → `_shell.html`                                                                                                                                                                                                                   |

WebSocket session (`packages/protocol`): the client sends `hello` with the token →
`welcome` (`mode: "live"` with SimConnect, `"replay"` with `--sim fake`; `sim.connected`
is true only after node-simconnect's `open()` resolved) → `snapshot` → `delta`/`event`
frames sharing one monotonic `seq`. `resync` returns a fresh snapshot. The server
pings every 15 s. Commands: `flight.start` (needs the aircraft on the ground with the
parking brake set; errors `sim_offline` while the simulator link is down, `flight_active`,
`no_data`, `not_on_ground`, `brake_not_set`;
with a loaded mission also `not_at_origin` beyond 3 nm, `insufficient_fuel`, `over_mtow`)
and `flight.end` (completed when Arrived; otherwise `not_arrived` unless
`args.abort === true`, which ends it as `aborted`; `no_flight` without one; `sim_offline`
without abort while the simulator link is down). Cargo
commands (P3, see `docs/ECONOMY.md`): `jobs.list`, `jobs.refresh {airport?, destination?}`,
`job.accept {jobId}`, `job.release {jobId}` (an in-transit job is abandoned: failed, −3
reputation), `mission.load {jobIds, destination?, enteredPayloadKg?}` (a `destination` other than the jobs' final
one makes a transit leg), `mission.payload {kg: number | null}` (the payload entered by you,
before departure only), `mission.unload`,
`mission.abort`, `settings.update {aircraftType?: key | null, base?, crewAllowanceKg?: kg | null}`; errors include
`bad_args`, `unknown_airport`, `job_unavailable`, `job_not_accepted`, `job_loaded`,
`mixed_route`, `same_airport`, `no_progress`, `payload_exceeded`, `runway_unsuitable`, `out_of_range`, `mission_active`,
`no_mission`, `mission_in_progress`, `unknown_type`. Every other command is answered with
`ok: false, error.code: "not_implemented"`. When the simulator connects or disconnects, every client receives a
new `welcome` + `snapshot`, and simulator-derived domains (including `phase` and `flight`) are
cleared on disconnect so stale values never look live. A running flight survives a drop: it
is suspended (no flight domain, no offline time counted, its phase kept) and resumes on the
first real sample after the reconnect, where a moved aircraft sets the teleport flag; without
a flight the phase and a half-begun leg are forgotten. The economy forgets the last parked
position and its payload preview turns `unknown` until the sim reports stations again. Close codes: `4401` bad/missing token, `4400` invalid
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
`mission.started`, `mission.delivered`, `mission.failed`, `mission.payload_check` and
`job.completed` events. It observes the flight core through hooks: start at the origin
(3 nm), the payload check (cargo vs `PAYLOAD STATION WEIGHT:n` minus a crew allowance,
previewed while loaded, frozen at departure; no stations → `unknown`, no penalty), leg
verification at
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

| Command                | Args                                                                              | Refusal codes                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fbo.buy`              | `{ icao, financing? }`                                                            | `unknown_airport`, `fbo_exists`, `unknown_lender`, `credit_score_too_low`, `ltv_exceeded`, `bad_term`, `insufficient_cash`                                                                                                                                                                                                                                        |
| `fbo.build`            | `{ icao, financing? }`                                                            | as `fbo.buy`                                                                                                                                                                                                                                                                                                                                                      |
| `fbo.sell`             | `{ fboId }`                                                                       | `unknown_fbo`, `fbo_building`, `underwater`                                                                                                                                                                                                                                                                                                                       |
| `fbo.module.buy`       | `{ fboId, module }`                                                               | `unknown_fbo`, `fbo_building`, `module_installed`, `module_pending`, `insufficient_cash`                                                                                                                                                                                                                                                                          |
| `fbo.module.upgrade`   | `{ fboId, module }`                                                               | `unknown_fbo`, `fbo_building`, `module_not_installed`, `module_max_level`, `module_pending`, `insufficient_cash`                                                                                                                                                                                                                                                  |
| `fbo.pricing`          | `{ fboId, fuelPriceRatio?, handlingFeeUsd? }`                                     | `bad_args` (ratio 0.7–1.5, fee $20–$300), `unknown_fbo`                                                                                                                                                                                                                                                                                                           |
| `insurance.buy`        | `{ aircraftId }`                                                                  | `unknown_aircraft`, `not_owned`, `already_insured`, `insufficient_cash`                                                                                                                                                                                                                                                                                           |
| `insurance.cancel`     | `{ aircraftId }`                                                                  | `unknown_aircraft`, `not_insured`, `repair_loan_open`                                                                                                                                                                                                                                                                                                             |
| `insurance.repairLoan` | `{ aircraftId, repair: overhaul\|all\|defect, defectId?, principal, termMonths }` | `bad_args`, `aircraft_on_mission` (checked before every book rule), `unknown_aircraft`, `not_owned`, `aircraft_busy` (hired, flying), `not_insured`, `repair_loan_open`, the repair's own codes (`no_wear`, `no_defects`, `unknown_defect`, `already_queued`), `no_repair_bill`, `bad_term` (6–24), `bad_principal` (< $500), `exceeds_bill`, `insufficient_cash` |

`module` is one of `fuel`, `hangar`, `maintenance`, `cargo`, `ramp`. Loans also accept
`collateral: { type: "fbo", id }`. Events: `fbo.income` (day close per FBO, own arrival,
sim AI), `fbo.built` (construction or module done), `demand.event`, `milestone.reached`,
`insurance.claim`, `insurance.cancelled` (the insurer cancelled a policy after three missed
repair-loan payments), `loan.called` (a repair loan called: third miss, repossession or write-off remainder, with `balanceMovedToCash`). Insurer repair loans (`insurance.repairLoan`) are rows of the `loans`
table with `kind: "repair"` in their JSON (no migration), listed by `GET /api/loans` and paid
off early with `loan.payoff`; `docs/ECONOMY.md` "Insurer repair loans" has the rules. Domains: `fbos`, `demand` (new), `insurance` on owned fleet aircraft,
`milestones` on the company. Storage: migration 6 (`fbos`, `fbo_modules`,
`fbo_transactions`, `demand_events`, `demand_index`, `insurance_policies`, `milestones`).

## Hired pilots (P6, optional; simulated)

A hired pilot flies one owned aircraft back and forth on a fixed route on the company clock
(docs/ECONOMY.md "Hired pilots"). It is a simulated economy model: it never produces flight
frames or telemetry domains, never writes logbook flights, never grades a landing and never
counts toward the player's own hours or landing streak. Legs are booked by the company book
when they complete (`hired_income`, `fuel`, `landing_fee` with `refType: "pilot"`; wages as
`pilot_wage`). The aircraft has the fleet status `hired` and `mission.load` refuses it with
`aircraft_with_hired_pilot` until the pilot is unassigned. Commands use the same WebSocket
token and Origin rules as every other command.

| Command          | Args                                            | Refusal codes                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pilot.hire`     | `{ rating: "turboprop" \| "jet" }`              | `bad_args`, `pilot_limit`, `insufficient_cash`                                                                                                                                                                                                                                                                                            |
| `pilot.fire`     | `{ pilotId }`                                   | `unknown_pilot`                                                                                                                                                                                                                                                                                                                           |
| `pilot.assign`   | `{ pilotId, aircraftId, origin?, destination }` | `unknown_pilot`, `pilot_assigned`, `unknown_aircraft`, `not_owned`, `aircraft_in_maintenance`, `aircraft_busy`, `aircraft_on_mission`, `ferry_only`, `rating_mismatch`, `aircraft_unairworthy`, `aircraft_not_at_origin`, `same_airport`, `airport_not_served`, `route_too_short`, `out_of_range`, `runway_unsuitable`, `payload_too_low` |
| `pilot.unassign` | `{ pilotId }`                                   | `unknown_pilot`, `not_assigned`                                                                                                                                                                                                                                                                                                           |

Event: `pilot.route_stopped` (`simulated: true`; aircraft grounded or unairworthy at a
departure, or no longer available). Domain: `pilots`. Storage: migration 9 (`hired_pilots`);
the career export carries `pilots` as an optional field of version 5.

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

`src/core/weather.ts`: METARs for the origin and destination (plan §3, §8). Mode `online`
(default with SimConnect) fetches `https://aviationweather.gov/api/data/metar?ids=…&format=json`
(NOAA Aviation Weather Center, public US Government data, no key) only when the page sends
`online=1` (its per-browser **Online weather** switch): all due stations in one request, a
`CargoOps/<version> (private use)` User-Agent, 10 s timeout, no retries, a 10-minute cache in
the `metar_cache` table, never more than one request per station per minute (also after a
failure). Offline or on errors the last report is served marked stale (up to 3 h), otherwise a
note. Decoding prefers the API's JSON fields and falls back to `packages/weather`'s parser on
`rawOb`; tested against the RECORDED `fixtures/awc-metar.recorded-2026-10-14.json` (from the
`metar-live` workflow; the cloud container cannot reach the host) and the HAND-MADE edge-case fixture `fixtures/awc-metar.handmade.json`. Mode `sample` (default with `--sim fake`) serves
built-in SAMPLE reports and never touches the network; `off` serves nothing.

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
- Every requested SimVar, system event and system state is in the allow-list
  `src/sim/simvar-catalog.ts` with its documented unit (audit: `docs/SIMVARS.md`);
  `test/simvar-catalog.test.ts` fails on an unknown name, an incompatible unit, a wrong
  datum type or a missing/extra `:index`.
- Entries marked `verified: false` still need the PC check: `SIMULATION RATE`,
  `PAYLOAD STATION WEIGHT`/`NAME`, `ENG FUEL FLOW PPH`, `PLANE TOUCHDOWN NORMAL VELOCITY`
  (ft/s, ×60; sign not documented, the analyser uses its magnitude) and
  `PLANE TOUCHDOWN BANK/PITCH DEGREES` (fast definition). On-ground comes from
  `SIM ON GROUND` (`IS ON GROUND` is not in either SDK's SimVar tables).
- `Pause_EX1`: any non-zero flag value (pause, active pause, esc-menu sim pause) is paused.
- System events: `Pause`, `Pause_EX1`, `SimStart`, `SimStop`, `FlightLoaded`,
  `AircraftLoaded`, `Crashed`, `CrashReset`, `1sec`; `requestSystemState("Sim")` on connect.
- The `sim` domain is only sent once a real `SIMULATION RATE` arrives (the schema needs
  it); until then the chip relies on `welcome.sim`.
- AI traffic (`requestDataOnSimObjectType`, AIRCRAFT) skips the user aircraft's own object
  id (taken from the user-aircraft frames) in case the request returns it.
- Facilities (`src/sim/facilities.ts`, `src/core/facilities.ts`): one airport facility
  definition per connection (airport + runway members, docs/SIMVARS.md "Facility
  definition") and `requestFacilityData` per ICAO, never the list calls. The economy asks for
  the board airport, the chosen destination and the 24 nearest candidates on `jobs.list` /
  `jobs.refresh`, the mission airports on `mission.load` and on connect; at most 4 requests
  in flight, 64 queued, 10 s timeout. Answers go to `msfs_airports` (migration 10, source
  `msfs`, refreshed after 7 days) and the `facilities` domain; misses, timeouts and a refused
  definition fall back to OurAirports (logged once per kind and connection).

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
