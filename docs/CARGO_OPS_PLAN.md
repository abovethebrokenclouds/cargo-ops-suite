# Cargo Ops — Build Plan

Status: **APPROVED 2026-10-13 by the owner.** Implementation is orchestrated from this document; no application code is in this PR.
Date: 2026-10-13. Branch: `claude/bold-wozniak-w71opj`.

This document is the single source of truth for building Cargo Ops, a private,
personal-use Microsoft Flight Simulator 2020/2024 cargo-operations companion for
one Windows PC. It records what exists today, every architectural and design
decision, the phased feature roadmap, the simulator-integration spec, the
open-source and zero-cost policy, the test strategy, and the orchestration
workflows an implementing session should run. Research findings are summarised
inline; anything not verified from a primary source is flagged in §14.

---

## 1. Decisions at a glance

| Area           | Decision                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product shape  | Browser UI (existing TanStack Start app) + a local Node connector on the Windows PC. No Electron, no cloud, no accounts.                                                                                                                                                                                                       | Smallest footprint, pure-JS SimConnect client, identical code path to the Lovable preview.                                                                               |
| Simulator link | `node-simconnect` 4.2.1 (LGPL-3.0-or-later, pure TypeScript, speaks the SimConnect wire protocol over named pipe/TCP). `Protocol.SunRise` for MSFS 2024, `KittyHawk` fallback for 2020.                                                                                                                                        | Only actively maintained open client with MSFS 2024 support; ships **no** Microsoft SDK binaries, so the unresolved SimConnect.dll redistribution question never arises. |
| Transport      | WebSocket + small HTTP API on `127.0.0.1:4311`, origin check + random local token. Snapshot/delta JSON protocol with an explicit `source: "sim"                                                                                                                                                                                | "replay"                                                                                                                                                                 | "demo"` on every frame. | Real vs demo data is a protocol fact, never a UI guess. |
| Web build      | Keep SSR/Cloudflare build for Lovable (default). `CARGO_OPS_LOCAL=1` enables TanStack Start SPA mode + `nitro: false`; the connector serves the static build.                                                                                                                                                                  | Verified: the Lovable wrapper passes `tanstackStart.spa` through and only warns.                                                                                         |
| Persistence    | Connector owns one SQLite file (`%LOCALAPPDATA%\CargoOps\cargo-ops.db`, WAL) via Node 24 built-in `node:sqlite`. UI never touches storage directly. IndexedDB only for per-browser UI prefs.                                                                                                                                   | One file to back up; zero native addons; post-flight processing on the server side.                                                                                      |
| Map            | MapLibre GL JS (BSD-3) + `pmtiles` (BSD-3) + `@protomaps/basemaps` dark flavor (BSD-3 code, CC0 design). Local Protomaps PMTiles extract as primary; OpenFreeMap `dark` style as online fallback (no key, no limits, no SLA); `world-atlas` (ISC/Natural Earth PD) as always-offline floor.                                    | No keys, no payment, OSM attribution shown in the map corner.                                                                                                            |
| Aviation data  | OurAirports CSVs (public domain) bundled; MSFS facilities via SimConnect as the live authority; aviationweather.gov METAR/TAF (US Gov, no key, 100 req/min, custom User-Agent, cached 10 min).                                                                                                                                 | Free, documented limits, no accounts.                                                                                                                                    |
| Design system  | Midnight navy/charcoal, electric blue primary, cyan accent, restrained violet tertiary, gradient text blue→cyan→violet. Space Grotesk (display), Inter (body, tabular numerals), JetBrains Mono (data). All self-hosted via Fontsource (OFL 1.1). Lucide icons (ISC), Maki map icons (CC0), in-house SVG aircraft silhouettes. | Matches the brief; current amber/orange tokens are replaced. No Google Fonts CDN at runtime.                                                                             |
| Charts         | uPlot (MIT) for telemetry strips; Recharts (MIT, already present) for styled dashboard charts.                                                                                                                                                                                                                                 | Throughput where needed, theming where it matters.                                                                                                                       |
| Tests          | Vitest + Testing Library (UI, protocol, reducers, phase FSM), FakeSimConnect JSONL replay, Playwright E2E vs fake connector, GitHub Actions on ubuntu + windows. Real SimConnect handshake is a manual checklist on the user's PC.                                                                                             | Everything that can be verified without MSFS is automated; the rest is recorded honestly.                                                                                |

---

## 2. Current state (verified in this session)

Repository: Lovable template `tanstack_start_ts_current`, React 19.2, TanStack
Start 1.168.60 / Router 1.170.41, Vite 8.1.5, Tailwind 4.2.1, shadcn/ui
(new-york, 40+ components), Recharts 2.15, Vitest 4, bun lockfile with a 24-hour
`minimumReleaseAge` supply-chain guard.

App code is ~860 lines outside `components/ui`:

| File                                            | Role                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/routes/__root.tsx`                         | Shell, head meta, error/not-found pages, loads fonts from `fonts.googleapis.com`        |
| `src/routes/index.tsx`, `jobs.tsx`, `fleet.tsx` | Three pages on mock data                                                                |
| `src/components/AppNav.tsx`                     | Nav + `PageHero`; hard-coded "MSFS 2024 offline" dot                                    |
| `src/lib/mock-data.ts`                          | Company, 3 aircraft, 3 jobs                                                             |
| `src/styles.css`                                | Tailwind 4 tokens (oklch), `text-gradient`, `panel`, `bg-gradient-brand`, `shadow-glow` |
| `src/test/app-routing.test.tsx`                 | One test: `/` matches a route                                                           |

Baseline run (cloud container, no MSFS):

| Check                           | Result                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | OK                                                                                       |
| `npx tsc --noEmit`              | OK                                                                                       |
| `bun run test`                  | 1/1 passed                                                                               |
| `bun run build`                 | OK, 1.5 MB output, cloudflare-module preset                                              |
| `bun run lint`                  | **FAIL**: 22 Prettier errors (auto-fixable), 6 react-refresh warnings in `components/ui` |

Gaps against the brief: no simulator link, no map, no persistence, no flight
tracking, no career model, wrong colour direction (amber/orange primary), fonts
fetched from a CDN, no asset inventory, one test.

---

## 3. Architecture

```
Windows gaming PC (everything on 127.0.0.1)
┌───────────────────────────────────────────────────────────────────────────┐
│ MSFS 2020 / 2024 ──SimConnect (named pipe, auto-discovered from registry)─┐ │
│                                                                          ▼ │
│  connector/  (Node 24 LTS, one process, started by scripts/start-cargo-ops) │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ sim/       SimConnectSource (node-simconnect) | FakeSource (JSONL)   │  │
│  │ core/      state store (snapshot+delta) · flight-phase FSM           │  │
│  │            flight verifier · landing analyser · job/economy engine   │  │
│  │            recorder (JSONL) · METAR fetcher (cached)                 │  │
│  │ storage/   node:sqlite → %LOCALAPPDATA%\CargoOps\cargo-ops.db        │  │
│  │ server/    http 127.0.0.1:4311  /            static web build        │  │
│  │            /api/* (Bearer token)  /ws (Origin + token check)         │  │
│  │            /tiles/*.pmtiles (local basemap, range requests)          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                   ▲ ws + http, same origin                 │
│  Edge/Chrome tab or installed PWA │                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ web app (this repo, SPA build)   transport = LiveWsTransport         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘

Lovable cloud preview (unchanged pipeline)
  vite build (SSR, cloudflare-module) → transport = DemoTransport (JSONL replay in-browser)
```

### 3.1 Repository layout (target)

```
cargo-ops-suite/
├─ src/                          # web app (Lovable builds this)
│  ├─ routes/                    # /, /flight, /map, /jobs, /fleet, /company, /logbook, /settings, /diagnostics
│  ├─ components/                # app components (token-only styling)
│  │  ├─ ui/                     # shadcn primitives (unchanged)
│  │  ├─ dashboard/  flight/  map/  cargo/  fleet/  logbook/  status/
│  ├─ lib/
│  │  ├─ transport/              # Transport interface, LiveWsTransport, DemoTransport, reconnect FSM
│  │  ├─ sim-state/              # reducer for snapshot/delta, selectors, derived metrics (ETE, endurance)
│  │  ├─ format/                 # units, tabular number formatting
│  │  └─ mock-data.ts            # demo seed only
│  ├─ assets/                    # in-house SVG silhouettes, map sprites, fonts via fontsource imports
│  └─ styles.css                 # design tokens
├─ packages/protocol/            # pure TS + zod: message schemas, telemetry frame, JSONL fixture type
├─ connector/                    # NOT part of the Vite build; own package.json + lockfile
│  ├─ src/{sim,core,storage,server,cli}/
│  ├─ fixtures/*.jsonl           # recorded telemetry (shared with web demo via copy script)
│  └─ test/
├─ data/                         # ourairports CSV snapshot + refresh script, basemap extract (git-ignored large files)
├─ e2e/                          # Playwright specs, webServer = fake connector
├─ scripts/                      # start-cargo-ops.cmd/.ps1, build-local.ps1, fetch-basemap.ps1, refresh-airports.ts
├─ docs/                         # this plan, ASSET_INVENTORY.md, VERIFICATION.md, SETUP_WINDOWS.md
└─ .github/workflows/ci.yml
```

Constraints that keep Lovable working:

- `connector/` is a standalone package (not a bun workspace), never imported by `src/`.
- `packages/protocol` is pure TypeScript, imported by the web app via a tsconfig path alias and by the connector relatively.
- `vite.config.ts` gains only env-guarded options: `spa` and `nitro:false` under `CARGO_OPS_LOCAL=1`; the default build stays SSR/Cloudflare.
- `src/server.ts` and `src/start.ts` stay free of URL/redirect/404 words (Lovable's `urlInspection: none` rule).
- No `window`/`WebSocket` access at module top level (SSR safety); transports mount in effects.
- Never force-push or rewrite history on `main` (Lovable sync).

### 3.2 Protocol (packages/protocol)

JSON messages, discriminated by `type`, with `v: 1` and a monotonically increasing `seq`.

```
C→S hello     { v, token, client:"web", wants:["telemetry","flight","jobs","company"] }
S→C welcome   { v, session, mode:"live"|"demo"|"replay", sim:{ connected, name, version, protocol } }
S→C snapshot  { seq, source, state:{ sim, aircraft, position, motion, fuel, weights, payload, plan, flight, phase, weather, company, jobs, fleet } }
S→C delta     { seq, source, patch:{ position?, motion?, fuel?, ... } }     // shallow merge per domain
S→C event     { seq, source, name:"sim.connected"|"sim.disconnected"|"sim.paused"|"sim.rate"|"flight.started"|"phase.changed"|"touchdown"|"flight.ended"|"job.completed"|"crash", data }
C→S command   { id, name:"job.accept"|"job.load"|"flight.start"|"flight.end"|"settings.update"|"fleet.buy"|..., args }
S→C result    { id, ok:true, data } | { id, ok:false, error:{ code, message } }
C→S resync    { lastSeq }
```

Rates: position/motion at 5 Hz in flight (10 Hz below 1,000 ft AGL), fuel/weights/plan at 1 Hz, everything else on change. Client reconnect: exponential backoff 0.5 s→30 s with jitter, server ping every 15 s, client watchdog 30 s.

Security: bind `127.0.0.1` only; reject WebSocket upgrades whose `Origin` is not the connector's own origin (or the Vite dev origin in development); 32-byte random token generated on first run into `%LOCALAPPDATA%\CargoOps\config.json`, delivered to the page via same-origin `GET /api/session`; `/api/*` requires `Authorization: Bearer`. LAN access is a later explicit opt-in.

Demo separation: `mode` in `welcome` and `source` on every frame drive a persistent status chip. Demo/replay flights are written to `demo.db`, never to the career database.

### 3.3 Storage schema (first cut)

`settings(key, json)`, `company(id, json, updated_at)`, `aircraft(id, reg, type_key, json)`,
`jobs(id, status, origin, dest, cargo_kind, weight_kg, payout, deadline_at, json)`,
`flights(id, started_at, ended_at, origin, dest, aircraft_id, job_ids, payload_kg, distance_nm, fuel_used_kg, landing_json, score_json, status, source)`,
`telemetry(flight_id, t_ms, json)` (1 Hz downsample; 5 Hz for the last 60 s before touchdown),
`metar_cache(station, fetched_at, json)`, `schema_migrations(version)`.
Backups: daily `VACUUM INTO %LOCALAPPDATA%\CargoOps\backups\`, plus `GET /api/export` (zip of db + JSON) and `POST /api/import`.

---

## 4. Design system

Direction: a premium aviation operations centre crossed with a high-end gaming companion. Not an admin dashboard.

### 4.1 Tokens (replace current amber set in `src/styles.css`)

| Token                                       | Value (oklch)                     | Use                         |
| ------------------------------------------- | --------------------------------- | --------------------------- |
| `--background`                              | 0.13 0.03 262 (midnight navy)     | page                        |
| `--card`                                    | 0.18 0.03 262                     | panels                      |
| `--secondary`/`--muted`                     | 0.23 0.03 262                     | chips, inputs               |
| `--primary`                                 | 0.72 0.19 255 (electric blue)     | CTAs, active                |
| `--accent`                                  | 0.82 0.14 205 (cyan)              | highlights, live indicators |
| `--tertiary` (new)                          | 0.62 0.20 295 (violet)            | gradients, secondary glow   |
| `--success` / `--warning` / `--destructive` | green 155 / amber 75 / red 25     | status lights               |
| `--*-foreground` on fills                   | 0.13 (dark), ≥ 4.5:1 on each fill | button / badge labels       |
| `--gradient-text`                           | 100° blue → cyan 45% → violet     | headings, key metrics       |
| `--gradient-glow`                           | radial blue + violet at low alpha | body backdrop               |
| `--shadow-glow`                             | blue glow                         | primary CTA                 |

Fonts: `--font-display: "Space Grotesk Variable"`, `--font-sans: "Inter Variable"`, `--font-mono: "JetBrains Mono Variable"`; `font-variant-numeric: tabular-nums` on all metric classes. Fonts imported from `@fontsource-variable/*` in `styles.css`; the two Google Fonts `<link>`s in `__root.tsx` are removed.

Utilities to add: `metric-xl` (display, 72–120 px, gradient), `metric-lg`, `metric-md`, `label-eyebrow` (tracking 0.3em), `status-dot` (illuminated, pulsing when live), `panel-elevated`, `panel-inset`, `grid-ops` (12-col responsive).

### 4.2 Component inventory (new)

`SimStatusChip` (live/demo/replay/disconnected with sim name and protocol), `MetricTile` (label, giant number, unit, trend, optional sparkline), `FlightProgressBar` (origin→dest with aircraft marker and ETE), `PhaseTimeline`, `FuelGauge` (quantity, flow, endurance vs ETE warning), `PayloadBar` (payload vs max, CG not required), `LandingCard` (rate fpm, G, GS, bank/pitch, touchdown offset, grade), `MissionCard` (route, cargo kind, weight, payout, deadline countdown, suitability badges), `JobBoardFilters`, `RouteFinder` (multi-hop stack), `FleetCard` (silhouette, condition, location, utilisation), `OpsMap` (MapLibre wrapper with aircraft, route, trail, airports, follow mode), `TelemetryStrip` (uPlot), `DiagnosticsPanel` (connection log, RTT, frame rate, sim events), `CompanyLedger`, `LogbookTable`/`FlightDetail`, `EmptyState` variants, `Toast` presets via sonner.

### 4.3 Pages

| Route                 | Purpose                                                                                                                                                                | Hero numbers                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `/` Ops Dashboard     | Connection state, active mission, next-best job, company KPIs, fleet summary, recent flights                                                                           | cash, active mission ETE, fuel endurance |
| `/flight` Live Flight | The in-flight screen: aircraft, mission, destination, altitude, IAS, GS, heading, VS, fuel, progress, ETA, phase, weather at destination, landing card after touchdown | altitude, airspeed, fuel, progress       |
| `/map` Ops Map        | Full-height map: aircraft, route, trail, origin/destination, nearby airports, METAR badges; follow/free modes                                                          | distance remaining                       |
| `/jobs` Job Board     | Generated contracts filtered by base/aircraft/range/payload, route finder, accept/load                                                                                 | payout                                   |
| `/fleet` Fleet        | Aircraft owned/leased, condition, location, maintenance; buy/sell/lease                                                                                                | fleet value                              |
| `/company` Company    | Cash, reputation, revenue/expenses chart, loans, milestones                                                                                                            | reputation                               |
| `/logbook` Logbook    | Flights with landing grade, distance, payload, exports (CSV/GPX/JSON)                                                                                                  | total hours                              |
| `/settings`           | Units, connector port/token, basemap source, backups, demo toggle                                                                                                      | —                                        |
| `/diagnostics`        | Raw telemetry, event log, protocol version, fixture recorder                                                                                                           | RTT, Hz                                  |

Motion: `tw-animate-css` for enter/exit, `motion` for number counters, page transitions and the live status pulse; MapLibre `easeTo` for camera follow. Respect `prefers-reduced-motion`.

---

## 5. Feature roadmap (phased, each phase ships green)

### P0 — Foundation (web + repo)

- Fix lint (`prettier --write`), add `.github/workflows/ci.yml` (lint, tsc, vitest, build default + `CARGO_OPS_LOCAL=1`).
- Design tokens, fonts via Fontsource, new utilities, `SimStatusChip`, `MetricTile`, page skeletons for all routes.
- `packages/protocol` with zod schemas + tests; `src/lib/transport` with `DemoTransport` (JSONL replay) and reconnect FSM; `sim-state` reducer + tests.
- `docs/ASSET_INVENTORY.md`, `docs/VERIFICATION.md` started.
- Acceptance: all routes render in demo mode with a visible "DEMO DATA" chip; CI green; no CDN requests.

### P1 — Connector MVP + Live Flight dashboard

- `connector/` package: node-simconnect source (SunRise→KittyHawk fallback), data definitions below, system events, state store, WS/HTTP server, static serving, token/origin checks, `--sim fake --fixture` and `--record` CLI flags, `node:sqlite` storage with migrations.
- `/flight` page live: aircraft title/tail, lat/lon, altitude, AGL, IAS/TAS/GS, heading, VS, fuel qty/flow/endurance, weights/payload, on-ground, engines, parking brake, pause/sim-rate badges.
- `/diagnostics` with connection log and event stream.
- Scripts: `start-cargo-ops.cmd/.ps1`, `build-local.ps1`, `docs/SETUP_WINDOWS.md`.
- Acceptance (cloud): fake connector E2E passes; (user PC): manual checklist §11.3 recorded in `VERIFICATION.md`, first real JSONL fixture committed.

### P2 — Map + flight tracking

- `OpsMap` with MapLibre + local PMTiles + OpenFreeMap fallback + world-atlas floor; aircraft marker rotated by heading, great-circle route, breadcrumb trail, follow mode, OSM attribution.
- Flight-phase FSM (vmsACARS rules + climb/cruise/descent split, forward-only with hysteresis), takeoff/landing detection, landing analyser (touchdown normal velocity, peak G within 800 ms, bounce detection), distance integration, ETE/ETA, endurance warning, pause/sim-rate handling, crash handling.
- Telemetry recording to SQLite; `LandingCard`; `TelemetryStrip`.
- Acceptance: replaying `kmem-katl.jsonl` yields deterministic phases, landing grade and distance within tolerance (unit tests on the FSM).

### P3 — Cargo operations

- Job generator from OurAirports + current base + aircraft range/payload + runway suitability; cargo kinds with multipliers and deadlines; stackable cargo across legs; route finder (multi-hop); dispatch pre-checks (payload, MTOW, fuel + 45 min reserve, runway length/surface).
- Mission lifecycle: accept → load → start (on ground, brake set, at origin) → verify leg (≥90 % of distance, arrival within 3 nm, no teleport) → deliver (parked, engines off, brake set) → payout with transparent breakdown.
- Logbook with exports (CSV, GPX, JSON career export/import).
- Acceptance: a full replayed mission completes end-to-end in E2E with the expected payout.

### P4 — Company, fleet, economy core

- Cash, reputation 0–100 with gates, revenue/expense ledger, fuel billed at landing airport price, dry/wet lease, wear/condition and repair, fleet buy/sell with reputation gates, aircraft type catalogue (payload/range/speed) with auto-match from `TITLE`.
- **Bank loans** (§7.2): lenders, credit score, offers, auto-debit, collateral, early payoff, default handling.
- Acceptance: economy formulas unit-tested against documented examples; ledger balances; a loan amortises correctly over a simulated month.

### P5 — Economy depth: used aircraft, airworthiness, FBOs

- **Used aircraft market** with per-system defects of variable severity, pre-purchase inspection, repair queue with downtime, airworthiness gate, ferry permits (§7.1).
- **FBO ownership**: buy or build at an airport, upgrade modules, earn from the player's own arrivals and from a modelled traffic stream, plus real AI traffic detected through SimConnect when the sim is running (§7.3).
- Dynamic per-airport demand and fuel pricing, insurance, milestones (§7.4).
- Acceptance: a used aircraft with a grounding defect cannot be dispatched until repaired; FBO income accrues from a replayed arrival; all new tables migrate from an existing database.

### P6 — Polish and packaging

- Animations, empty states, keyboard shortcuts, PWA manifest for an installable window, backups/export UI, optional `@yao-pkg/pkg` connector exe (node-simconnect kept unbundled for LGPL), auto-start instructions, SimBrief OFP import (free fetch API, optional), in-sim toolbar panel (optional).
- Acceptance: final `VERIFICATION.md` with cloud-verified vs PC-verified matrix; inventory complete.

Explicitly out of scope: multi-user, auth, billing, leaderboards, cloud sync, paid data.

---

## 6. Simulator integration spec

### 6.1 Data definition (request units chosen to avoid client conversions)

| Field           | SimVar                                                                                                                | Requested unit                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| title, tail     | `TITLE`, `ATC ID`                                                                                                     | string                           |
| lat, lon        | `PLANE LATITUDE`, `PLANE LONGITUDE`                                                                                   | degrees                          |
| alt, agl        | `INDICATED ALTITUDE`, `PLANE ALT ABOVE GROUND`                                                                        | feet                             |
| ias, tas, gs    | `AIRSPEED INDICATED`, `AIRSPEED TRUE`, `GROUND VELOCITY`                                                              | knots                            |
| hdgMag, hdgTrue | `PLANE HEADING DEGREES MAGNETIC/TRUE`                                                                                 | degrees                          |
| vs              | `VERTICAL SPEED`                                                                                                      | feet per minute                  |
| fuelGal, fuelLb | `FUEL TOTAL QUANTITY`, `FUEL TOTAL QUANTITY WEIGHT`                                                                   | gallons, pounds                  |
| fuelFlow[n]     | `ENG FUEL FLOW PPH:n` (legacy; see risk)                                                                              | pounds per hour                  |
| weights         | `TOTAL WEIGHT`, `EMPTY WEIGHT`, `MAX GROSS WEIGHT`                                                                    | pounds                           |
| payload         | `PAYLOAD STATION COUNT`, `PAYLOAD STATION WEIGHT:i`, `PAYLOAD STATION NAME:i`                                         | pounds (community-verified unit) |
| onGround        | `IS ON GROUND` (not `SIM ON GROUND`, per 2024 docs)                                                                   | bool                             |
| engines         | `GENERAL ENG COMBUSTION:n`                                                                                            | bool                             |
| brake           | `BRAKE PARKING POSITION`                                                                                              | bool                             |
| simRate         | `SIMULATION RATE` (unverified name)                                                                                   | number                           |
| zulu            | `ZULU TIME`, `ZULU DAY OF MONTH`, `ZULU MONTH OF YEAR`, `ZULU YEAR`                                                   | seconds, number                  |
| touchdown       | `PLANE TOUCHDOWN NORMAL VELOCITY` (ft/s ×60), `PLANE TOUCHDOWN BANK/PITCH/HEADING/LATITUDE/LONGITUDE`                 | —                                |
| gForce          | `G FORCE`                                                                                                             | number                           |
| plan            | `GPS IS ACTIVE FLIGHT PLAN`, `GPS FLIGHT PLAN WP COUNT/INDEX`, `GPS WP NEXT ID/LAT/LON`, `GPS WP DISTANCE`, `GPS ETE` | deprecated in 2024, best-effort  |

System events: `Pause`, `Pause_EX1`, `SimStart`, `SimStop`, `FlightLoaded`, `AircraftLoaded`, `Crashed`, `CrashReset`, `1sec`. Also `RequestSystemState("Sim")` on connect.

Facilities: `requestFacilitiesListEx1` for nearby airports; `addToFacilityDefinition` + `requestFacilityData` per ICAO; cached in SQLite because of known 2024 regressions.

### 6.2 Flight phase FSM

Boarding (ground + brake) → Pushback/TaxiOut (GS > 5 kt) → Takeoff (`IS ON GROUND` false, GS > 30 kt) → Climb (VS > +300 fpm for 30 s) → Cruise (|VS| < 300 fpm) → Descent (VS < −300 fpm) → Approach (< 3,000 ft AGL or TOD) → Landing (touchdown latched) → TaxiIn (GS < 30 kt off runway) → Arrived (parked, engines off, brake set). Forward-only with hysteresis; re-takeoff after touch-and-go re-enters Climb.

### 6.3 Landing analysis

Rate from `PLANE TOUCHDOWN NORMAL VELOCITY`; peak `G FORCE` within 800 ms; bounce if AGL rises above 35 ft then re-descends through 5 ft; grade = min(rate grade, G grade, speed grade) using bands 60/120/200/300/400/600 fpm and 1.1/1.4/1.7 G; store touchdown lat/lon for the map card.

### 6.4 Verification rules

Start requires on-ground + brake + within 3 nm of origin. Distance integrated by great circle at 1 Hz; teleport flag if Δpos > GS × Δt × 3. Pause stops the mission clock. Sim rate ≤ 4× allowed, no bonuses while > 1×, invalidated > 8×. Crash → mission failed, repair bill, reputation loss, flight preserved in logbook as failed.

---

## 7. Cargo operations and economy spec

- Job generation: from current base and owned/leased aircraft; destination candidates from OurAirports filtered by type, runway length/surface vs aircraft minimums, distance within 80 % range; weight ≤ max payload − leg fuel. Kinds: cargo, fragile (G cap 1.5), express (deadline = now + nm/typical GS + 45 min), medical, hazmat, bush. Many short jobs plus a few long ones.
- Payout: `base = rate × kg × nm × atan(nm/25)/atan(1)`; × kind {1.0, 1.3, 1.5, 1.8, 1.6}; × conditions (1 + 0.15 IFR + 0.15 night + 0.20 weather); × (1 + 0.02 × reputation tier); × landing {1.10, 1.05, 1.00, 0.85, 0.60}; − late penalty − damage. Load scaling `n^-0.3` for multi-unit jobs. Show the breakdown on the payout screen.
- Costs: fuel burned (from `FUEL TOTAL QUANTITY` delta) at the landing airport's price (base price ± 20 % by airport size/remoteness); dry lease per engine-hour or wet lease; loans with simple interest; landing fees by airport size.
- Wear: `+0.5 %/flight-hour + 2 % × max(0, G − 1.4)/0.3 + 5 % per overspeed event`; dispatch blocked under 20 %; repair cost ∝ price × wear.
- Reputation 0–100: +1..+3 per clean delivery, −5 hard landing, −20 crash, −3 per late hour; tiers gate aircraft classes, loans and job kinds.
- Fleet: catalogue of types (payload, range, cruise speed, price) matched to `TITLE` with manual override; buy/sell/lease.

---

### 7.1 Used aircraft market and airworthiness

- **Listings** are generated per aircraft type with age (years), airframe hours, cycles, location (an OurAirports airport, so a ferry flight may be needed), asking price and a seller note. Price = catalogue price × age/hours depreciation × (1 − defect discount) ± market noise.
- **Systems** tracked per airframe: engine(s), propeller/thrust reversers, airframe/structure, landing gear and brakes, avionics, electrical, fuel system, hydraulics, cargo hold/door, interior/paint. Each system has a condition 0–100 and a list of **defects**.
- **Defects** have a severity: `cosmetic` (no effect), `minor` (small cost/efficiency penalty, deferred allowed for 30 flight hours), `major` (performance penalty: +5–15 % fuel burn, reduced max payload, higher failure chance), `grounding` (aircraft is not airworthy until fixed). Each defect has a repair cost (∝ catalogue price × severity), a downtime in hours, and a `hidden` flag.
- **Pre-purchase inspection** (fee ≈ 0.5 % of asking price, one in-game day) reveals hidden defects; buying without one carries the risk that grounding defects surface on the first flight (rolled at purchase, revealed on dispatch).
- **Airworthiness gate**: dispatch requires zero grounding defects, no deferred minor defect past its limit, condition of every system ≥ 20 %, and a current annual inspection (every 12 months or 100 flight hours, whichever first; cost ∝ catalogue price). A **ferry permit** allows one flight with major defects to the nearest maintenance-capable airport (own FBO maintenance shop or a large airport), with a payload cap and no job revenue.
- **Repair queue**: repairs run against in-game time (which advances with real time while the connector runs, and with flight time); cheaper and faster at an owned FBO with a maintenance shop; parts for rare types cost more. The player sees a maintenance board with estimated completion.
- **Wear → new defects**: the P4 wear model now rolls for new defects when wear crosses thresholds, after hard landings (G > 1.6 → gear/airframe), overspeed (airframe), running tanks dry (fuel/engine) and crashes (multiple grounding defects or write-off).
- **Resale**: selling price uses the same formula, so fixing a bargain and reselling is a viable play; reputation does not change on resale.

### 7.2 Bank loans

- **Lenders** (3 fictional banks with different risk appetite): each offers an APR, maximum loan-to-value (LTV) and term range. Offers depend on a **credit score** derived from reputation, months of positive cash flow, existing debt ratio and defaults.
- **Loan** = principal, APR, term (6–120 months of in-game time), monthly payment (standard amortisation), collateral (the financed aircraft or FBO), origination fee (1 %), early-payoff allowed at any time without penalty.
- **Auto-debit** on each in-game month boundary; a missed payment (insufficient cash) adds a late fee and −5 reputation; three consecutive misses → **repossession** of the collateral and a default flag that halves the credit score for 12 months.
- UI: loan calculator with live monthly payment, ledger entries per debit, debt-to-income gauge on the Company page, "financed" badge on fleet cards.
- Tables: `loans(id, lender, principal, apr, term_months, payment, balance, collateral_type, collateral_id, next_due_at, missed_count, status)`, `ledger` gains `category` values `loan_disbursement`, `loan_payment`, `late_fee`.

### 7.3 FBOs (fixed-base operations)

- **Acquire**: buy an existing FBO at an airport (price ∝ airport size from OurAirports `type` and `scheduled_service`) or **build** one (land lease + construction cost and a build time of 3–14 in-game days). One FBO per airport; any number of airports.
- **Modules** (each with purchase cost, upgrade levels 1–3, monthly upkeep):
  - _Fuel farm_: sells fuel to arriving traffic at a price the player sets around the regional base price; higher levels raise capacity and margin. Also fuels the player's own aircraft at cost.
  - _Hangar_: parking for owned aircraft (no ramp fees, slower wear from weather), rents spare bays to traffic.
  - _Maintenance shop_: repairs own aircraft cheaper and faster (§7.1); services traffic for revenue; level gates which defect classes it can fix.
  - _Cargo terminal_: more and better-paying jobs generated at that airport; handling fees from traffic.
  - _Ramp and services_: landing/parking fees, ground handling, crew lounge (small reputation bonus for the player's own flights through the airport).
- **Income sources**:
  1. **The player's own arrivals**: on every verified arrival at an FBO airport the modules trigger (fuel at cost, free parking, cheaper repairs, faster job turnaround).
  2. **Modelled traffic**: a deterministic daily traffic stream per airport derived from OurAirports attributes (type, scheduled service, runway count/length) and time of day; each modelled movement buys fuel, parking, handling with probabilities set by module levels and player pricing (too-high prices lose customers). Accrues while the connector runs, in in-game time.
  3. **Real sim traffic (when connected)**: the connector samples AI aircraft near the FBO airport via `requestDataOnSimObjectType` (AIRCRAFT category) and credits a bonus for each real arrival it observes, so live traffic in the sim visibly matters. Clearly labelled as a bonus so the economy still works offline.
- **Management UI**: FBO page per airport with module cards, pricing sliders, daily income chart, occupancy, upgrade queue; map pins for owned FBOs; a monthly P&L line per FBO in the Company ledger. Loans may finance FBO purchases (§7.2).
- Tables: `fbos(id, icao, status, built_at, json)`, `fbo_modules(fbo_id, kind, level, json)`, `fbo_transactions(fbo_id, at, kind, amount, source: own|modelled|sim_ai)`.

### 7.4 Other intelligent features (planned, P5 unless noted)

- **Dynamic demand**: per-airport demand index drifts with the player's activity and random events (storm, festival, strike), raising job payouts and fuel prices locally for a few days.
- **Insurance**: optional hull policy per aircraft (monthly premium ∝ value) that covers a share of crash write-offs and repossession-free repair loans.
- **Hired pilots (P6, optional)**: AI pilots fly owned aircraft on fixed routes in in-game time for a wage, generating modest income and wear while the player flies something else.
- **Milestones and achievements**: first delivery, 100 hours, first FBO, debt-free, perfect landing streak; shown on the Company page.

## 8. Maps and aviation data

- Basemap: `scripts/fetch-basemap.ps1` downloads a dated Protomaps build and extracts a region (`pmtiles extract --bbox --maxzoom`) into `data/basemap/*.pmtiles` (git-ignored; a z0–7 world extract of roughly 100–200 MB plus an optional regional z0–11). Served by the connector with HTTP range support. Style = `@protomaps/basemaps` `dark` flavor overridden with app tokens. Attribution line: `© OpenStreetMap contributors (ODbL) · Protomaps`.
- Online fallback: OpenFreeMap `https://tiles.openfreemap.org/styles/dark` (no key, no stated limits, donation-funded, no SLA). Attribution: `© OpenStreetMap contributors · © OpenMapTiles`.
- Offline floor: `world-atlas` 110m TopoJSON as a fill/line source so the map never renders blank.
- Airports: `data/ourairports/*.csv` snapshot with a refresh script and date stamp; loaded into SQLite on first run; MSFS facilities override when the sim is connected.
- Weather: aviationweather.gov `api/data/metar` and `taf` JSON, custom `User-Agent: CargoOps/<version> (private use)`, 10-minute cache, max 1 request/min per station, failure degrades gracefully. _Status after the METAR lane:_ METAR implemented (connector `src/core/weather.ts`, `GET /api/weather/metar`, `packages/weather`, per-browser **Online weather** switch, SAMPLE reports in demo/replay); delivered over HTTP rather than the `weather` snapshot domain. _After the TAF/map lane:_ TAF implemented the same way (`GET /api/weather/taf`, 30-minute cache in `taf_cache`, periods FM/BECMG/TEMPO/PROB parsed by `packages/weather` with a flight category each, destination timeline with ETA marker under the METAR panel, SAMPLE TAFs in demo/replay); `/map` shows METAR flight-category badges for the route ends and accepted-job airports (with a connector, the map makes one `GET /api/weather/metar` for its badge stations (route ends, mission and accepted-job airports, at most 8) every 5 minutes while the badge layer is on and none while it is off; all weather panels on a page share one browser-side cache per product, so stations already loaded are not requested again and stations asked for in the same tick go in one request; the connector fetches from aviationweather.gov only stations not in its 10-minute cache and only when Online weather is on). The live TAF JSON shape is checked by the `metar-live` workflow (built against the documented shape; no recording yet). The IFR/weather payout bonuses are not implemented yet.
- Never: Mapbox, MapTiler, Stadia, `tile.openstreetmap.org`, Navigraph, openAIP (key + non-commercial), X-Plane apt.dat (GPL).

---

## 9. Open-source and zero-cost policy

Rules applied to every dependency and asset: verify the exact license from the package registry or LICENSE file; prefer MIT/ISC/BSD/Apache-2.0/OFL/CC0/public domain; LGPL allowed only as a separable runtime dependency (node-simconnect stays unbundled in `node_modules` with its license text shipped); GPL/AGPL/NC/proprietary code is ideas-only; no API keys, no accounts, no trials; free services documented with limits; nothing redistributed without a verified license; Unsplash/Pexels never described as open source; no Microsoft SDK binaries shipped.

Required non-open component: the SimConnect **server** lives inside MSFS itself (installed with the game). Cargo Ops ships only a protocol client; no SDK files are required at build or run time.

The living inventory is `docs/ASSET_INVENTORY.md` (skeleton created with this plan). CI will fail if a new dependency is not listed there (simple script in P0).

---

## 10. Testing and verification record

| Layer            | Tool                                             | What it proves                                                                                                                                                 |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | Vitest                                           | protocol codecs, reducers, phase FSM, landing analyser, economy formulas, job generator determinism (seeded)                                                   |
| Component        | Testing Library                                  | status chip states, metric formatting, mission card, landing card                                                                                              |
| Integration      | Vitest + fake connector (`--sim fake --fixture`) | flights persisted, payout computed, exports valid                                                                                                              |
| E2E              | Playwright (Chromium, preinstalled here)         | demo mode pages; live mode against fake connector; full replayed mission                                                                                       |
| Build            | CI                                               | default (Lovable SSR) and local SPA builds both pass; connector builds on Windows runner with Node 24                                                          |
| Manual (user PC) | checklist                                        | real SimConnect handshake 2020 and 2024, registry discovery, first fixture recording, pause/sim-rate events, facilities calls, firewall behaviour, PWA install |

`docs/VERIFICATION.md` keeps two tables: "verified in cloud CI" and "requires Windows PC with MSFS", each row dated with the commit. No feature is described as complete until its row is green.

---

## 11. Startup and operation on Windows

1. Install Node 24 LTS (one-time). 2. Clone the repo. 3. Run `scripts\start-cargo-ops.cmd`: installs connector deps on first run, builds the SPA if missing, starts the connector on `127.0.0.1:4311`, opens the browser. 4. Start MSFS; the chip turns from "SIM OFFLINE" to "LIVE · MSFS 2024 · SunRise" automatically. 5. Optional: install as a PWA from the browser menu; add the script to `shell:startup`.

Troubleshooting lives in `docs/SETUP_WINDOWS.md` (ports, token reset, logs in `%LOCALAPPDATA%\CargoOps\logs`, SimConnect.xml only for remote-PC setups).

---

## 12. Orchestration workflows (for the implementing session)

The implementing session acts as orchestrator and uses the Workflow tool (or parallel subagents) with these lanes. Lanes marked ∥ can run concurrently in isolated worktrees; each lane ends with lint + tsc + tests + both builds before it is merged.

| Lane                  | Scope                                                                                          | Depends on |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| L0 Repo hygiene       | Prettier fix, CI workflow, docs scaffolding, inventory check script                            | —          |
| L1 Design system ∥    | tokens, fonts, utilities, `SimStatusChip`, `MetricTile`, page skeletons                        | L0         |
| L2 Protocol + state ∥ | `packages/protocol`, reducer, `DemoTransport`, reconnect FSM, fixtures format                  | L0         |
| L3 Connector ∥        | node-simconnect source, fake source, store, WS/HTTP server, sqlite, CLI, scripts               | L2         |
| L4 Live Flight page   | binds L1 components to L2 state; diagnostics page                                              | L1, L2     |
| L5 Map + data ∥       | MapLibre, PMTiles pipeline, OurAirports loader, METAR fetcher                                  | L1, L3     |
| L6 Flight tracking    | phase FSM, landing analyser, verifier, recorder                                                | L3         |
| L7 Cargo ops          | job generator, missions, dispatch checks, route finder, logbook, exports                       | L5, L6     |
| L8 Economy + fleet    | ledger, reputation, wear, fleet management, bank loans                                         | L7         |
| L8b Economy depth ∥   | used aircraft market, defects and airworthiness, repair queue, FBOs, dynamic demand, insurance | L8         |
| L9 Polish + packaging | motion, PWA, backups UI, optional exe, docs                                                    | L8b        |
| LQ QA (continuous)    | E2E specs, verification record, inventory audits, adversarial review of each PR                | all        |

Workflow sketch (pipeline per phase, review+verify fan-out per lane):

```js
export const meta = {
  name: "cargo-ops-phase",
  description: "Build one Cargo Ops phase lane-by-lane with review and verification",
  phases: [{ title: "Implement" }, { title: "Review" }, { title: "Verify" }],
};
const LANES = args.lanes; // e.g. [{ key:'L1', prompt:'...' }, { key:'L2', prompt:'...' }]
const results = await pipeline(
  LANES,
  (lane) =>
    agent(lane.prompt, { label: `impl:${lane.key}`, phase: "Implement", isolation: "worktree" }),
  (impl) =>
    parallel([
      () =>
        agent(
          `Adversarially review the diff for ${impl.key}: correctness, policy (§9), tokens-only styling, SSR safety`,
          { label: `review:${impl.key}`, phase: "Review" },
        ),
      () =>
        agent(`Run lint, tsc, vitest, both builds and e2e for ${impl.key}; report exact output`, {
          label: `verify:${impl.key}`,
          phase: "Verify",
        }),
    ]),
);
return { results };
```

Guardrails for every lane: token-only styling (no hard-coded colours), no new dependency without an inventory row and verified license, no network calls except the documented ones, no fabricated telemetry, no "connected" state without a real `welcome`, keep Lovable's default build green, small PRs to the working branch, never rewrite pushed history.

Suggested PR sequence: P0 (one PR), P1 (connector PR + flight page PR), P2 (map PR + tracking PR), P3, P4, P5 (used market PR + FBO PR), P6.

---

## 13. Reference projects and what to borrow

| Project                                                           | License  | Borrow                                                                                                     |
| ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| EvenAR/node-simconnect                                            | LGPL-3.0 | the SimConnect client itself                                                                               |
| immrk/next-efb                                                    | MIT      | main/renderer split, LAN token auth pattern                                                                |
| mracko/MSFS-Landing-Inspector                                     | MIT      | landing rate bands, 20-sample on-ground debounce, G cross-check                                            |
| piero-la-lune/FSE-Planner                                         | MIT      | job-map filters and multi-hop route finder UX                                                              |
| till213/SkyDolly                                                  | MIT      | SQLite logbook schema, sample-rate strategy, GPX/KML/IGC export design                                     |
| Pomax/msfs-simconnect-api-wrapper                                 | CC0      | SimVar/unit tables                                                                                         |
| phpVMS vmsACARS docs                                              | docs     | phase-detection rules                                                                                      |
| OnAir, Volanta, NeoFly, MSFS 2024 Career, TouchdownFX             | closed   | landing card, grade = min of sub-grades, stackable cargo, rank gates, composite landing score (ideas only) |
| Little Navmap, Flight Events, Mobile Companion, Python-SimConnect | GPL/AGPL | ideas only; never copy code                                                                                |

---

## 14. Risks and unverified items

1. **MSFS 2024 GPS flight-plan SimVars are deprecated** and may not reflect EFB-made plans. Mitigation: best-effort plan reading, manual destination selection, optional SimBrief import.
2. **Legacy fuel/payload SimVars on 2024 aircraft** can mismatch the new fuel system. Mitigation: show the source of each number; allow configured payload; validate against `TOTAL WEIGHT`.
3. **Facilities API regressions in 2024** (list callbacks, VOR/NDB frequencies, ident layout). Mitigation: OurAirports as baseline, SQLite cache, per-ICAO requests.
4. **`Pause`/`Pause_EX1` reporting bugs** in some builds. Mitigation: combine with `SimStart/SimStop` and `RequestSystemState("Sim")`.
5. **node-simconnect is community-maintained** (single primary maintainer). Mitigation: pin version, FakeSource for everything else, protocol fallback to KittyHawk.
6. **LGPL packaging**: never bundle node-simconnect into a single exe; keep it in `node_modules` with its license.
7. **`node:sqlite` is Stability 1.2 on Node 24**. Mitigation: thin storage adapter; better-sqlite3 (MIT) as fallback.
8. **SPA shell behaviour** in TanStack Start: first paint shows a pending fallback until hydration; no SSR-only assumptions in loaders.
9. **Lovable wrapper forces its Nitro preset in its sandbox**; local options must stay env-guarded.
10. **bunfig 24 h minimum release age** can reject freshly published versions for a day.
11. **Firewall prompt on loopback bind** is expected not to appear (community consensus, unverified).
12. **Unverified primary sources** (sandbox could not reach docs.flightsimulator.com, devsupport, osmfoundation, protomaps docs, ourairports.com, aviationweather.gov): SimVar names `SIMULATION RATE`, `PAYLOAD STATION *` units, `ESTIMATED FUEL FLOW`; Protomaps build sizes; OSM tile policy wording; OurAirports license sentence (confirmed via multiple secondary sources); AWC rate-limit wording; openAIP NC vs NC-SA. All to be re-checked from the user's PC where those hosts are reachable, and recorded in `VERIFICATION.md`.
13. **Real-simulator validation cannot happen in this environment.** Every simulator-facing feature stays marked "cloud-verified with fixtures only" until the user runs the checklist on the Windows PC.

---

## 15. Approval record

Approved by the owner on 2026-10-13 with these additions, now folded into §5 and §7: used aircraft with variable defects that must be fixed to be airworthy, bank loans for aircraft, and FBOs that can be bought or built, upgraded, and earn from incoming flights. The LGPL client, the optional online fallbacks and the default basemap size were accepted as proposed; any of these can still be changed by editing this document before the relevant phase starts.
