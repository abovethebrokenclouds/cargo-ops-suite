# Cargo Ops — Economy (P3)

Every formula, constant and rule of the cargo operations lane, as implemented. The
code is `packages/economy/src` (pure, deterministic, shared by the connector and the
browser demo) and `connector/src/core/economy/engine.ts` (mission lifecycle,
persistence). Constants live in `packages/economy/src/constants.ts`; change them
there and here together.

## Aircraft type catalogue

`packages/protocol/src/aircraft-types.ts`: 11 representative cargo-capable types
(PC-6 Porter, Kodiak 100, C208B Grand Caravan, DHC-6 Twin Otter, PC-12, King Air
350, ATR 72-600F, Dash 8-400, A320P2F, 737-800BCF, 747-8F) with max payload, range,
cruise speed, minimum runway, allowed surfaces, cruise fuel burn and typical
approach speed. **All figures are approximate, rounded from public spec sheets, for
gameplay** — not performance data and not copied from any dataset.

- Active type = manual override (`settings.update { aircraftType }`) → else the sim
  `TITLE` matched case-insensitively against keyword groups (first catalogue match
  wins, e.g. "208" or "caravan" → C208B) → else the default C208B.
- The approach speed is the reference for the landing speed grade (§6.3): touchdown
  GS ≤ ref + 5 kt → A+, + 10 → A, + 20 → C, + 30 → D, above → E.
- Airport surfaces (OurAirports codes) map to paved / gravel / turf / dirt / water /
  unknown; unknown or missing runway data makes an airport unsuitable.

## Job generator

Seeded with mulberry32 (written in-house). Board seed =
FNV-1a(company seed, board airport, aircraft type key, board counter). A new demo/
replay company uses seed 20261013; a new live company a random seed.

| Rule               | Value                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Destinations       | bundled OurAirports large + medium airports ≠ origin, runway known, longest runway ≥ type minimum, surface allowed, 20 nm ≤ d ≤ 0.8 × range  |
| Payload limit      | max payload − leg fuel, leg fuel = burn × (nm / cruise + 45 min)                                                                             |
| Short / long       | 75 % from the short band (≤ max(60 nm, 35 % of max distance)), 25 % from the long band                                                       |
| Destination weight | large 3, medium 2 (small 1 if ever added)                                                                                                    |
| Kinds (weight)     | cargo 40, express 15, fragile 12, medical 10, hazmat 8, bush 40 (bush only to unpaved or < 4,000 ft strips with a type that accepts unpaved) |
| Units              | cargo 1–6, fragile 1–3, express 1–2, medical 1–2, hazmat 1–4, bush 1–4                                                                       |
| Weight             | payload limit × uniform share (express/medical 10–45 %, fragile 20–70 %, hazmat 20–80 %, others 25–100 %), rounded to 5 kg, ≥ 50 kg          |
| Time limit         | express: nm / cruise + 45 min; medical: × 1.25 + 60 min; others: × 2 + 240 min; rounded up to 5 min                                          |
| Board              | 24 jobs per board, wall-clock expiry 24 h, at most 4 airports' boards on offer                                                               |
| Refresh            | on demand (`jobs.refresh {airport?, destination?}`), when the active type changes, and every 6 h of simulator time observed by the connector |
| Focus              | `destination` puts the first 3 jobs on that airport when the type can serve it                                                               |

The deadline clock starts at block-out and runs on simulator time (pauses
excluded, the tracker's clock): the connector cannot observe in-game time between
accepting and departing.

## Payout

```
base   = 0.015 $/kg·nm × kg × nm × atan(nm / 25) / atan(1)
gross  = base × kind × n^-0.3 × conditions × (1 + 0.02 × tier) × landing
total  = max(0, round(gross − late penalty − damage))
```

| Factor     | Values                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind       | cargo 1.0, fragile 1.3, express 1.5, medical 1.8, hazmat 1.6, **bush 1.4** (the plan lists five values for six kinds; bush sits between fragile and the critical kinds) |
| load       | n^-0.3 for n handling units (bulk discount; 1 for single-unit jobs)                                                                                                     |
| conditions | 1 + 0.15 IFR + 0.15 night + 0.20 weather — **1.00 in P3**: IFR/weather need METAR (P5) and night needs the sim's zulu time, which the protocol does not carry yet       |
| reputation | tier = floor(reputation / 20) → 0–5                                                                                                                                     |
| landing    | A+ 1.10, A 1.05, B 1.00, C 1.00, D 0.85, E 0.60, F 0.60 (the plan's five values over seven grades); no touchdown recorded → 1.00                                        |
| late       | 10 % of gross per late hour, pro rata, capped at 100 %; late = flight block minutes − job time limit                                                                    |
| damage     | fragile only: peak touchdown G > 1.5 → 50 % of gross. Wear/repairs are P4                                                                                               |
| noBonus    | sim rate went above 1× during the flight: conditions and reputation become 1.00 and the landing multiplier is capped at 1.00 (D/E/F penalties still apply)              |

Board estimates use landing 1.00, on time and the reputation at generation time;
the delivered payout is recomputed with the real values and stored with every
factor (`PayoutBreakdown`: base, factors with labels/notes, gross, deductions,
total).

### Worked examples (`packages/economy/test/economy.test.ts`)

1. General cargo, 500 kg, 100 nm, 1 unit, reputation 50, landing B, on time:
   atan(4)/atan(1) = 1.6880835 → base = 0.015 × 500 × 100 × 1.6880835 = **$1,266.06**;
   × 1.0 × 1 × 1.00 × 1.04 × 1.00 = 1,316.71 → **$1,317**.
2. Express, 950 kg in 2 units, 287.7 nm, reputation 50, landing A+, 30 min late:
   curve 1.8896377 → base **$7,746.99**; × 1.5 × 2^-0.3 (0.8122524) × 1.00 × 1.04 ×
   1.10 = **$10,797.96** gross; late 0.5 h × 10 % = 5 % → −$539.90 → **$10,258**.
3. Fragile, 400 kg in 3 units, 150 nm, reputation 85 (tier 4), landing D at 1.62 G,
   sim rate > 1× (noBonus): curve 1.7897262 → base **$1,610.75**; × 1.3 × 3^-0.3
   (0.7192231) × 1.00 × 1.00 (no bonus) × 0.85 = **$1,280.13**; fragile damage 50 %
   → −$640.07 → **$640**.

### Acceptance (connector replay)

Company seed 4242, board #2 at KMEM for the C208B with focus KATL: first KATL job
is general cargo, 840 kg, 1 unit, 287.7 nm. Replaying `demo-kmem-katl.jsonl`
(landing B at −142 fpm / 1.18 G, block ≈ 119 min, on time) pays
0.015 × 840 × 287.7 × 1.8896377 = 6,849.98 × 1.04 = 7,123.98 → **$7,124**, cash
250,000 → 257,124, reputation 50 → 52 (`connector/test/economy.test.ts`).

## Mission lifecycle and verification (plan §6.4)

`accept → load → start → verify leg → deliver → payout`

- **accept / release**: available ↔ accepted (max 20 accepted). Expired jobs leave
  the board.
- **load** (`mission.load {jobIds}`): one open mission at a time; all jobs accepted
  and sharing origin and destination (stacked cargo); destination runway suits the
  active type; distance ≤ 80 % of range; total weight ≤ max payload − leg fuel.
  `mission.unload` returns the jobs to accepted before departure.
- **start**: with a loaded mission an explicit `flight.start` additionally needs the
  aircraft within **3 nm** of the origin airport (`not_at_origin`), fuel ≥ leg fuel
  - 45 min (`insufficient_fuel`, when the sim reports fuel) and total weight ≤ max
    gross (`over_mtow`, when reported). A flight that starts by itself at takeoff
    picks the mission up when the last parked sample (on ground, brake set) was within
    3 nm of the origin; otherwise the mission stays loaded with `startBlocked`.
- **verify** at Arrived (parked, engines off, brake set): not crashed, not
  invalidated (sim rate > 8×), no teleport flag, flown distance ≥ **90 %** of the
  great circle origin → destination, parked within **3 nm** of the destination.
- **deliver**: every job paid with its breakdown, cash credited, one `job_payout`
  ledger row per job, `job.completed` per job and `mission.delivered`.
- **fail**: crash → `failed`, no payout, reputation −20; a failed verification →
  `failed`, no payout, no reputation change; `mission.failed` event. Jobs end
  `failed`.
- **abort**: `mission.abort`, `flight.end {abort:true}` or a session reset (replay
  restart) → mission `aborted`, jobs back to accepted, no penalty.

Reputation (0–100, start 50): on time with landing A+/A **+3**, B **+2**, C or no
grade **+1**; landing D/E/F **−5**; **−3 per started late hour** (and no clean
bonus when late); crash **−20**.

## Route finder

Exhaustive depth-first search from the current board airport over every job on
offer (all boards plus accepted jobs), at most 3 legs, never revisiting an airport.
Each leg stacks its same-route jobs greedily by payout per kg within the leg's
payload limit. Chains are ranked by total estimated payout (then fewer legs, then
shorter). Multi-hop chains need boards at the intermediate airports (refresh a board
there). Carrying one job across several legs (transit cargo) is not modelled yet.

## Storage and exports

Migration 3: `missions`, `mission_jobs`, `ledger(id, at, category, amount, ref_type,
ref_id, memo, json)` (category `job_payout` now; P4 adds fuel, lease, `loan_*`,
`late_fee` …), `jobs.created_at`, `jobs.mission_id`. The company is the v1
`company` table (id `company`, JSON with name, base, cash, reputation, seed, board
counter, boards, type override). Replays write `demo.db`, live sessions
`cargo-ops.db`.

Exports: logbook CSV, GPX 1.1 per flight from the telemetry table (point times =
start + simulator time since block-out), JSON career export (company, jobs,
missions, ledger, flights; no telemetry). Import validates with zod, replaces the
career tables, keeps telemetry of flights that remain, is refused while a flight or
mission is in progress and never accepts replay/demo flights into the live database.

## Deferred

- P4: fuel billed at the landing airport, leases, wear/condition and repair bills
  (crash repair bill), landing fees, the full ledger UI, reputation gates.
- P5: IFR/night/weather condition bonuses (METAR, sim zulu time), dynamic demand,
  small/GA airports beyond the bundled large + medium subset, transit cargo.
