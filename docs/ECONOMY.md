# Cargo Ops — Economy (P3 + P4 + P5)

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

---

# P4 — Company, fleet, costs and bank loans

Code: `packages/economy/src/{company-constants,clock,costs,fleet-rules,finance,book,demo-company}.ts`
(pure, shared by the connector and the browser demo) and the connector's
`core/economy/engine.ts` (persistence, commands, events). Every constant below lives in
`company-constants.ts`; the worked examples are unit tests in
`packages/economy/test/company.test.ts` and `connector/test/company.test.ts`.

## Ledger and company

- **Every cash change is a ledger entry** (`CompanyBook.post`): amounts are rounded to
  cents, each row stores the running `balance` (cash after the entry) and the company-
  clock time `game_at`. Invariant, tested after every scenario and exposed as
  `balanced` by `GET /api/ledger`:

  ```
  Σ ledger amounts = cash − starting cash   (to the cent)
  ```

- Categories: `mission_payout` (P3 `job_payout`, renamed by migration 4), `fuel`,
  `landing_fee`, `lease`, `repair`, `purchase`, `sale`, `loan_disbursement`,
  `loan_payment` (principal), `loan_fee` (1 % origination), `late_fee`, `interest`,
  `insurance` (placeholder, nothing books it yet) and `adjustment` (tests/tools only).
- **Operating P&L** per in-game month = all categories except the capital flows
  (`loan_disbursement`, `loan_payment`, `purchase`, `sale`); revenue = positive entries,
  expense = negative ones. The last 24 months are kept on the company record.
- **Net worth** = cash + Σ owned aircraft market value − outstanding loan principal.
- **New company**: $250,000, reputation 50 and one owned Cessna 208B at the base (the
  starter aircraft; not a cash change). A P3 company without a fleet gets the same
  starter on first load.

### Reputation tiers and gates (tier = floor(reputation / 20))

| Tier | Name        | Reputation | Buy aircraft classes (lease one tier lower) | Job kinds added               | Lenders open (min tier) |
| ---- | ----------- | ---------- | ------------------------------------------- | ----------------------------- | ----------------------- |
| 0    | Startup     | 0–19       | single-piston, single-turboprop             | cargo, express, fragile, bush | Jetwash Credit          |
| 1    | Regional    | 20–39      | + twin-turboprop                            | + medical                     | + Vectorline Mutual     |
| 2    | Established | 40–59      | + regional-turboprop                        | + hazmat                      | + Altocirrus Bank       |
| 3    | Trusted     | 60–79      | + narrowbody-jet                            | —                             | —                       |
| 4    | Premier     | 80–99      | + widebody-jet                              | —                             | —                       |
| 5    | Elite       | 100        | all                                         | —                             | —                       |

The generator never draws a kind above the tier (weight 0), so boards at reputation ≥ 40
are identical to P3's. `fleet.buy` / `fleet.lease` refuse with `reputation_gate`.

## Costs (plan §7)

Booked when a mission flight ends (delivered, failed or aborted), on the mission's
aircraft, and listed in `mission.payout.costs` (delivered) or `mission.costs` (failed /
aborted) with `payout.net = total − costs`.

- **Fuel**: kg burned (`fuelUsedLb × 0.45359237`, from the tracker's fuel quantity delta)
  × the landing airport's price (the origin's for a crash or an abort away from an
  airport). Not billed on a wet lease.

  ```
  price = 1.95 $/kg × (1 + clamp(size + remoteness + noise, −20 %, +20 %))   → 0.001 $/kg
  size       = large −5 %, medium +3 %, small +8 %
  remoteness = +2 % per 100 nm to the nearest other large airport, ≤ +10 %
  noise      = ±5 % × (2 × FNV-1a("fuel|IDENT") / 2³² − 1)
  ```

  Worked example, KATL (large): nearest other large airport 116.2 nm → +2.32 %, noise
  +0.88 % → 1.95 × (1 − 0.05 + 0.0232 + 0.0088) = **$1.915/kg**. KMEM $1.948, KBNA
  $1.920, KSDF $1.890, KLIT (medium) $1.992, PANC (1,153 nm from another large
  airport) $2.061.

- **Landing fee** where the aircraft parks (within 3 nm, at least one touchdown):
  size base (large $300, medium $120, small $40) × category factor (single-piston 0.5,
  single-turboprop 1, twin-turboprop 1.5, regional-turboprop 3, narrowbody 8,
  widebody 20). KATL with the C208B: **$300**; a 737 at a large airport $2,400.
- **Lease hours**: dry = block hours × engines × dry rate (you also pay fuel); wet =
  block hours × wet rate (fuel included). Plus the monthly lease fee below.

**Acceptance (connector replay, `demo-kmem-katl.jsonl`)**: the P3 mission (payout
**$7,124**) burned 623.1 lb = 282.63 kg → fuel 282.63 × 1.915 = **$541.24**, landing fee
**$300**, net **$6,282.76**; cash 250,000 → **$256,282.76**; the ledger holds
`mission_payout +7,124`, `fuel −541.24`, `landing_fee −300` and balances; the starter
C208B moved KMEM → KATL, 1 cycle, 1.77 h, wear 106.1 airborne min × 0.5/60 = **0.88** →
condition **99.12 %**.

## Fleet

- **Catalogue** (`aircraft-types.ts`, approximate gameplay figures, in-house): new price,
  dry lease $/engine-hour, wet lease $/block hour, engines and Vmo/Vne:

  | Type                | Price | Dry /eng-h | Wet /h  | Engines | Vmo kt |
  | ------------------- | ----- | ---------- | ------- | ------- | ------ |
  | PC-6 Porter         | $2.3M | $280       | $650    | 1       | 151    |
  | Kodiak 100          | $2.6M | $300       | $750    | 1       | 182    |
  | C208B Grand Caravan | $2.7M | $320       | $800    | 1       | 175    |
  | DHC-6 Twin Otter    | $7.0M | $380       | $1,600  | 2       | 170    |
  | PC-12               | $5.5M | $520       | $1,150  | 1       | 240    |
  | King Air 350        | $8.0M | $420       | $1,700  | 2       | 263    |
  | ATR 72-600F         | $20M  | $650       | $3,400  | 2       | 250    |
  | Dash 8-400          | $25M  | $750       | $4,000  | 2       | 286    |
  | A320P2F             | $35M  | $1,300     | $8,500  | 2       | 350    |
  | 737-800BCF          | $40M  | $1,400     | $9,000  | 2       | 340    |
  | 747-8F              | $180M | $3,500     | $30,000 | 4       | 365    |

- **Owned aircraft**: registration (deterministic `N` + 3 digits + 2 letters from the
  company seed and a counter), type, ownership (owned / dry_lease / wet_lease), location,
  flight hours, cycles, condition 0–100 %, status (available, in_flight, maintenance;
  sold / returned / repossessed rows stay in the table but leave the fleet).
- **Buy** (`fleet.buy`): price from cash, or financed (below). Delivered to the active
  aircraft's airport, else the base (or `airport`).
- **Sell** (`fleet.sell`, owned only): dealer pays **90 % of the market value**; an open
  loan on it is paid off from the proceeds (`underwater` when it does not cover it).
- **Lease** (`fleet.lease {kind: dry|wet}`): **0.25 % of the catalogue price per in-game
  month** (the first month up front, then at every month boundary) plus the hourly rate
  per flight. `fleet.return` charges the repair cost of the wear accrued.
- **Market value** = price × max(0.4, 1 − 0.00002 × flight hours) × (0.7 + 0.3 ×
  condition/100). Example: C208B, 120 h, 97.5 % → 2.7M × 0.9976 × 0.9925 =
  **$2,673,318.60**.
- **Wear** per flight (plan §7), percentage points of condition:

  ```
  wear = 0.5 × airborne hours + 2 × max(0, peak touchdown G − 1.4) / 0.3 + 5 × overspeed events (+ 50 crash)
  ```

  Examples: 100 min, 1.18 G → **0.83**; 150 min, 1.85 G, one overspeed → 1.25 + 3 + 5 =
  **9.25**. **Overspeed**: IAS above the type's Vmo/Vne for ≥ 3 s of simulator time is
  one event; the next needs IAS back below Vmo − 5 kt (`OverspeedDetector`). The demo
  fixture peaks at 160 kt (C208B Vmo 175), so it has none; a test pushes IAS to 190 kt
  and gets exactly +5.

- **Dispatch**: missions load only on the selected fleet aircraft when it is available,
  **condition ≥ 20 %** (`aircraft_unairworthy`), not in maintenance
  (`aircraft_in_maintenance`) and **parked at the mission origin**
  (`aircraft_not_at_origin`); the start checks repeat this. The aircraft's location
  moves to the destination on delivery (to the airport it parked at after a failed
  leg; unchanged after a crash).
- **Repair** (`fleet.repair`): cost = 8 % × catalogue price × wear / 100; time = 2 h +
  1.5 h × wear points of in-game time, then condition 100 % and `repair.completed`.
  Example: C208B at 97.5 % → **$5,400**, **5.75 h**; at 19.5 % → $173,880, 122.75 h.
- **TITLE → fleet aircraft** (`selectAircraft`): a manual `fleet.select` wins; else the
  TITLE is matched to a catalogue type and the one fleet aircraft of that type is used;
  with several, the one parked at the airport within 3 nm of the sim position; otherwise
  `ambiguous` (load refused with `aircraft_ambiguous` until one is selected). Without a
  TITLE match a one-aircraft fleet selects itself. The board's type is the manual type
  override → the selected aircraft's type (`source: "fleet"`) → TITLE → C208B.
- **Ferry flights** (moving an aircraft without a mission) are not modelled yet: only
  mission flights book costs, wear and relocation (P5 ferry permits, §7.1).

## Company clock (in-game time)

```
per tick:  game Δ = max(wall Δ capped at 60 s, simulator Δ since the last tick)
```

The connector ticks every second and on every flight sample. Real time runs the clock
while the connector runs (also while the sim is paused); a flight at 4× sim rate runs it
4× (simulator Δ comes from the flight core's sim clock, which stops while paused); a
sleeping PC or a stopped connector adds at most 60 s. The month is **30 in-game days**;
`company.clock` = { gameMs, month, day }. Loans, lease fees and repairs process in time
order when the clock passes them (`CompanyBook.advance`). Tests inject the wall clock
and use `advanceGameTime` for months.

## Bank loans (plan §7.2)

Three fictional lenders (invented names; any resemblance to a real institution is
unintended):

| Lender            | Appetite     | APR range | Max LTV | Term      | Min score | Min tier |
| ----------------- | ------------ | --------- | ------- | --------- | --------- | -------- |
| Altocirrus Bank   | conservative | 5.5–8 %   | 70 %    | 24–120 mo | 600       | 2        |
| Vectorline Mutual | balanced     | 8–12 %    | 80 %    | 12–84 mo  | 450       | 1        |
| Jetwash Credit    | aggressive   | 12–18 %   | 85 %    | 6–60 mo   | 300       | 0        |

- **Credit score** 0–850 = 3 × reputation (≤ 300) + 25 × closed in-game months of the
  last 12 with positive operating net (≤ 12 → 300) + 250 × (1 − min(1, debt / assets)),
  assets = max(0, cash) + owned aircraft value; **floor(score / 2) for 12 in-game months
  after a repossession**, during which only the aggressive lender would consider you.
  New company: 150 + 0 + 250 = **400**. Example: reputation 70, 6 positive months, $1M
  debt on $4M assets → 210 + 150 + 188 = **548** (274 after a default).
- **Offer APR** = minApr + (maxApr − minApr) × clamp((850 − score) / (850 − minScore), 0, 1),
  rounded to 0.01 %. Score 400: Altocirrus 8 % (declines), Vectorline 12 % (declines),
  **Jetwash 16.91 %**; score 700: 7 %, 9.5 %, 13.64 %.
- **Loan** (`loan.take`, or `fleet.buy` with `financing`): principal ≤ max LTV × collateral
  value (the aircraft's market value, or the purchase price), term in the lender's range,
  ≥ $1,000; **origination fee 1 %** (`loan_fee`). Collateral is generic
  (`collateral_type`, `collateral_id`: `aircraft` now, `fbo` in P5); one active loan
  per collateral (`collateral_encumbered`).
- **Payment** (standard amortisation, cents): `P × r / (1 − (1 + r)^−n)`, r = APR / 12.
  Each month interest = round2(balance × r), principal = payment − interest; the last
  payment clears the balance exactly.
- **Auto-debit** at `nextDueGameMs` = taken + 1 in-game month, then every month:
  `interest` and `loan_payment` (principal) entries and a `loan.payment` event.
- **Missed payment** (cash < payment): late fee = max($100, 5 % of the payment)
  (booked even if cash goes negative), **−5 reputation**, the month's interest is added
  to the balance and the term extends by a month, `loan.missed`. **Three consecutive
  misses** → **repossession**: the collateral leaves the fleet, the loan is `defaulted`
  (balance written off, no cash), the default flag halves the credit score for 12
  months, `aircraft.repossessed`. A successful payment resets the count.
- **Early payoff** (`loan.payoff`): pays the outstanding principal, no penalty, no
  partial-month interest; frees the collateral.
- **Debt-to-income** (Company page) = Σ active monthly payments / average operating
  revenue of the last 3 in-game months.

### Amortisation acceptance (exact cents)

$100,000 at 12 % for 12 months: payment **$8,884.88**.

| Month | Payment  | Interest | Principal | Balance   |
| ----- | -------- | -------- | --------- | --------- |
| 1     | 8,884.88 | 1,000.00 | 7,884.88  | 92,115.12 |
| 2     | 8,884.88 | 921.15   | 7,963.73  | 84,151.39 |
| 3     | 8,884.88 | 841.51   | 8,043.37  | 76,108.02 |
| …     |          |          |           |           |
| 11    | 8,884.88 | 175.07   | 8,709.81  | 8,796.88  |
| 12    | 8,884.85 | 87.97    | 8,796.88  | 0.00      |

Auto-debit over simulated months (book and connector): Jetwash, $250,000, 24 months at
16.91 % → payment **$12,349.76**; month 1 interest $3,522.92, principal $8,826.84,
balance $241,173.16; month 24 pays $12,349.70 and the balance is 0; total interest
$46,394.18 — every debit equals an integer-cent reference table computed independently
in the test. Missed path: a $500,000 Jetwash loan with no cash → three `loan.missed`
(late fee each, reputation 50 → 35), then `aircraft.repossessed`, loan `defaulted`,
score halved, flag lapsing after 12 months; the ledger still balances.

## Storage, export and API (P4)

Migration 4: `fleet(id, registration, type_key, ownership, status, location, condition,
loan_id, acquired_at, json)`, `aircraft_events(id, aircraft_id, at, game_at, kind, json)`
(starter, purchased, leased, financed, flight with wear and costs, repair.started,
repair.completed, sold, returned, repossessed), `loans(id, lender, principal, apr,
term_months, payment, balance, collateral_type, collateral_id, next_due_at, missed_count,
status, json)`, `ledger.balance`, `ledger.game_at`, `job_payout → mission_payout`
(running balance of P3 rows rebuilt from $250,000), settings row `economy.phase = 4`.
The company record gains startingCash, gameMs, monthBilled, defaultUntilGameMs, fleet and
loan counters, selectedAircraftId, pnl and ledgerCount, all with defaults so P3 rows
load. Career export **version 2** adds `fleet`, `loans` and `aircraftEvents` (and ledger
`gameMs`/`balance`); version 1 imports are accepted (`job_payout` mapped, balances
recomputed, starter aircraft granted on reload). API: `GET /api/ledger`,
`/api/fleet`, `/api/loans` (Bearer token; see `connector/README.md`).

## Demo

`buildDemoCompany(lookup)` runs a fixed script on the same book (17 KMEM/KATL/KBNA/KSDF/
KLIT deliveries priced with `computePayout`, a $400,000 Jetwash loan on the starter on
day 20.5, a dry-leased Kodiak on day 24) to day 77.6. Every value it produces is shown
tagged DEMO with all actions disabled.

## Deferred

- P5 part 2 (next lane): FBOs (own maintenance shops extend `isMaintenanceCapable`, FBO
  collateral), insurance premiums (category exists), dynamic demand and fuel prices,
  milestones (placeholder on the Company page), IFR/night/weather condition bonuses,
  small/GA airports, transit cargo.
- Leases are never cancelled for non-payment: their monthly fee is booked even when it
  drives cash negative (only loans have a missed-payment path).

---

# P5 — used aircraft and airworthiness

Code: `packages/economy/src/{maintenance-constants,airworthiness,market}.ts` and the P5
parts of `book.ts` (pure, seeded, shared by the connector and the browser demo); the
connector's `core/economy/engine.ts` (dispatch gate on `mission.load` / `flight.start`,
ferry flights, dry-tank detection, commands); protocol `packages/protocol/src/maintenance.ts`.
Every constant lives in `maintenance-constants.ts`. Worked examples are unit tests in
`packages/economy/test/maintenance.test.ts` and `connector/test/airworthiness.test.ts`.

## Systems and the P4 `condition`

Every airframe tracks ten systems, each with a condition 0–100 % and a list of defects:

| System                       | Weight | Cost factor | Time factor |
| ---------------------------- | ------ | ----------- | ----------- |
| Engine(s)                    | 0.20   | 1.6         | 1.5         |
| Propeller / thrust reversers | 0.06   | 1.0         | 1.0         |
| Airframe / structure         | 0.20   | 1.3         | 1.3         |
| Landing gear & brakes        | 0.12   | 0.9         | 1.0         |
| Avionics                     | 0.08   | 1.0         | 0.8         |
| Electrical                   | 0.07   | 0.6         | 0.8         |
| Fuel system                  | 0.08   | 0.7         | 1.0         |
| Hydraulics                   | 0.07   | 0.7         | 1.0         |
| Cargo hold / door            | 0.07   | 0.5         | 0.7         |
| Interior / paint             | 0.05   | 0.4         | 0.6         |

- **The P4 `condition` is now derived**: `condition = Σ weight × system condition` (to
  0.01 %). The protocol field keeps its meaning (and the P4 overhaul/value formulas keep
  using it), so P4 clients still read a correct number.
- **Migration of P4 aircraft** (on load, after migration 5): the stored condition is mapped
  onto every system (so the weighted mean is unchanged), no defects, a current annual
  inspection dated at the company clock and airframe hours of the first P5 load, and a P4
  repair in progress becomes an already-paid overhaul order ending at its `readyAtGameMs`.
- **Wear** (P4 formula unchanged) lands on the systems so the weighted mean drops by exactly
  the P4 wear (until a system reaches 0): flight-hour and crash wear evenly; touchdown-G wear
  half evenly, half on gear + airframe (`Δ = 0.5 × g / (0.12 + 0.20)`); overspeed wear half
  evenly, half on the airframe (`Δ = 0.5 × o / 0.20`).
  Example (P4's 150 min, 1.85 G, one overspeed: 1.25 + 3 + 5 = 9.25): every system −5.25,
  gear −4.6875 more, airframe −4.6875 − 12.5 more → engines **94.75**, gear **90.06**,
  airframe **77.56**, condition **90.75** = 100 − 9.25. The replayed KMEM→KATL leg (0.88)
  leaves every system at 99.12 %.
- The P4 **overhaul** (`fleet.repair`) is unchanged: 8 % × price × wear / 100, 2 h + 1.5 h ×
  wear; it brings every system back to 100 % (it does not fix defects).

## Defects

`{ id, system, severity, title, repairCost, downtimeHours, hidden, cause, foundGameMs?,
fuelBurnPct?, payloadPct?, deferredAtHours? }`. Titles are short generated phrases per
system and severity (in-house).

| Severity  | Cost share of the catalogue price | Hours | Effect                                                                                                                                                           |
| --------- | --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cosmetic  | 0.04 %                            | 4     | none                                                                                                                                                             |
| minor     | 0.2 %                             | 8     | +1 % fuel; must be repaired or **deferred** (MEL) to fly; a deferral lasts 30 flight hours                                                                       |
| major     | 0.8 %                             | 24    | +5–15 % fuel and −5–15 % max payload (rolled per defect, payload penalty ≤ 30 % in total); escalates to grounding with 3 % per airborne hour (≤ 50 % per flight) |
| grounding | 2.5 %                             | 60    | not airworthy until repaired                                                                                                                                     |

```
repair cost (maintenance airport) = price × severity share × system cost factor × parts rarity
downtime   (maintenance airport) = severity hours × system time factor
field repair (elsewhere)          = cost × 1.35, time × 1.5
parts rarity: PC-6 1.25, DHC-6 1.2, 747-8F 1.2, Kodiak 1.15, ATR/Dash 8 1.1, PC-12 1.05, others 1
```

Examples (C208B $2.7M): engine grounding **$108,000 / 90 h** (field $145,800 / 135 h);
engine major **$34,560 / 36 h**; gear minor **$4,860 / 8 h**; interior cosmetic **$432 /
2.4 h**; a PC-6 engine grounding costs **$115,000** (rarity 1.25). Fuel billed after a
flight = kg burned × (1 + known defect fuel % / 100) × the airport price (the cost note
says so); `mission.load` caps the payload at `payload limit × (1 − payload penalty)`.

## Airworthiness gate (plan §7.1)

Dispatch (`mission.load`, an explicit `flight.start`, a ferry permit request) first lets
**hidden defects surface** (`defect.found` each; `aircraft.grounded` when one grounds it),
then requires:

1. no known **grounding** defect (`grounding_defect`);
2. every known **minor** defect repaired or deferred (`minor_not_deferred`) and no deferral
   past 30 flight hours (`deferral_expired`);
3. every **system ≥ 20 %** (`system_below_minimum`);
4. a current **annual inspection** (`annual_due`): due 12 in-game months (360 days) or
   100 flight hours after the last one, whichever first; "soon" within 30 days or 10 h.

Major defects do not block dispatch (they cost fuel and payload and may escalate). A
refusal is `aircraft_unairworthy` with a message listing every reason and `error.reasons`
(`[{code, message}]`, additive in the result schema). An explicit `flight.start` without a
mission is refused the same way when the selected fleet aircraft is parked where the sim
is (free flights in other aircraft are unaffected). Badge: **Airworthy**, **Grounded**,
**Ferry only** (a permit is active), **Annual due** (the annual is the only reason).

Annual inspection (`fleet.annual`): **0.4 % of the catalogue price × rarity × shop factor**,
downtime by category (single-piston 12 h, single-turboprop 16, twin-turboprop 24, regional
36, narrowbody 48, widebody 72) × shop time factor; on completion the clock restarts at
that time and the airframe hours, and hidden defects surface (`inspection.completed`).
C208B: **$10,800 / 16 h** at a large airport, $14,580 / 24 h elsewhere; PC-6 $11,500.

Deferral (`fleet.defer`): minor defects only, free; records the airframe hours.
Example: deferred at 10 h → 30 h left; at 40.5 h the gate reports `deferral_expired`.

## Ferry permits

- **Maintenance-capable airports**: `MaintenanceCapability.isMaintenanceCapable(icao)`;
  P5 part 1 = every **large** airport of the bundled data. The FBO lane wraps it with the
  player's own maintenance shops (and may lower the shop factors).
- **Eligible** (`fleet.ferryPermit`): available, no known grounding defect, every system
  ≥ 10 %, and a reason to ferry (the gate fails, or a major defect is open); not already at
  a maintenance-capable airport (`at_maintenance_airport`: repair there); destination =
  the **nearest** maintenance-capable airport within the type's range.
- Fee **$400 × the landing-fee category factor** (C208B $400, 737 $3,200), ledger `permit`;
  **payload cap 10 % of max payload** (C208B 136 kg: crew and baggage).
- The aircraft is **Ferry only**: `mission.load` refuses it (`ferry_only`, no job revenue).
  The next flight without a mission by the selected aircraft, starting within 3 nm of the
  permit origin, is the ferry: an explicit start is refused above the payload cap
  (`ferry_payload_cap`); at the end the leg books fuel, the landing fee and wear (and
  defect rolls) with `refType = "ferry"`, the aircraft moves to where it parked, and the
  permit is used up (once airborne). A connector restart mid-ferry keeps the permit unused.
- Example (connector test, only KATL capable): C208B at KMEM with 100 h since the annual →
  permit KMEM→KATL 287.7 nm, $400, ≤ 136 kg; the replayed flight with 250 lb payload books
  fuel + the $300 KATL landing fee, no payout; then the annual at KATL ($10,800, 16 h).

## Repair queue

Every repair, overhaul and annual is a **maintenance order** `{kind, defectIds, airport,
shop, cost, hours, startGameMs, readyAtGameMs}`, paid when queued. Orders of one aircraft
run **back to back** on the company clock (`start = max(now, last order's end)`); the
aircraft is `maintenance` until its last order ends (`repair.completed` / `inspection.completed`).
`fleet.repairDefect` repairs one known defect, `fleet.repairAll` every known defect not
yet queued, at the shop where the aircraft is parked. The fleet domain's `maintenance`
list is the board (ETA = `readyAtGameMs`). Example: engine grounding $108,000 / 90 h
queued, then the gear minor ($4,860 / 8 h) starts at 90 h and ends at 98 h.

## Wear → new defects (seeded per flight)

Seed = FNV-1a(company seed, aircraft id, "flight", cycles before, flight ref). New defects
are known at once (`defect.found`, `aircraft.grounded` when grounding):

- a system crossing **75 / 50 / 30 %** rolls **50 %** for a defect on it (75: cosmetic 40 /
  minor 60; 50: minor 60 / major 40; 30: major 60 / grounding 40);
- **hard landing** peak G > 1.6: chance `0.3 + (G − 1.6) / 0.4` (≤ 1) of a gear (60 %) or
  airframe (40 %) defect: < 1.9 G minor/major (60/40), < 2.3 G major/grounding (70/30),
  ≥ 2.3 G grounding (1.7 G → 55 %);
- **overspeed**: per event 50 % for an airframe minor or major (50/50);
- **tanks run dry**: an engine major and a fuel-system minor. Detected by the connector
  when, during a mission or ferry flight and airborne, the sim's fuel quantity drops to
  `max(1 lb, 0.5 % of the fuel at block-out)` (C208B with 1,700 lb: 8.5 lb);
- **crash**: 2–4 grounding defects on distinct systems (airframe, gear, engines,
  propeller); **written off** when the condition after the crash wear (+50) is below 25 %
  (status `written_off`, leaves the fleet; a loan on it stays to be paid);
- every open **major** escalates to grounding at 3 % per airborne hour (≤ 50 %).

## Used market

Generation seed = FNV-1a(company seed, "market", generation); 12 listings per generation,
a new generation every **7 in-game days** (`market.refresh` on demand); listings with an
inspection pending or done stay across generations.

- **Type**: weighted by category (single 3, twin 2, regional 1.5, narrowbody 1,
  widebody 0.5). **Location**: 65 % within 600 nm of the base, else any bundled airport;
  its runway must suit the type (a ferry may be needed to bring it home).
- **Age** 1–30 years; **hours** = age × category hours/year (single-piston 250,
  single-turboprop 450, twin 550, regional 1,400, narrowbody 2,400, widebody 3,200) ×
  0.6–1.4 (utilisation); **cycles** = hours × 1.3 / 1.1 / 1.0 / 0.9 / 0.6 / 0.2.
- **Systems**: base = 95 − 1.1 × age − 8 × (utilisation − 1) ± 5 (35–98), each system
  base −12…+8 (12–100).
- **Defects**: `rand(0, 1 + ⌊age / 8⌋)` plus one more 25 % of the time; severity cosmetic 30 /
  minor 34 / major 24 / grounding 12; hidden 10 / 25 / 35 / 50 %. Hidden defects never
  leave the connector (not in frames, `/api/market` or the demo view).
- **Seller note**: an opener + a tail by condition (≥ 80 good, ≥ 55 mid, else poor) from
  short in-house phrases; "grounded" when a grounding defect is disclosed.

### Value and asking price (listings and resale share it)

```
base      = price × max(0.4, 1 − 0.00002 × hours) × (0.7 + 0.3 × condition) × ageFactor
ageFactor = max(0.4, 1 − 0.035 × completed years)
discount  = min(0.6, 2 × known repair bill / base)          (hidden defects are not priced)
value     = base × (1 − discount)
asking    = round to $500 of value × (1 + noise), noise ∈ [−8 %, +8 %)
```

A new aircraft (age 0, no defects) is worth exactly the P4 market value, so P4 values and
the $2.7M starter are unchanged in its first in-game year. Owned aircraft age with the
company clock (12 × 30-day months a year). **Resale** (`fleet.sell`) = 90 % × this value,
reputation unchanged.

Worked example: C208B, 12 years, 6,000 h, 75 %, one known engine major ($34,560):
P4 value 2.7M × 0.88 × 0.925 = $2,197,800; × 0.58 = **$1,274,724**; discount 2 × 34,560 /
1,274,724 = **5.42 %**; value **$1,205,633.96**; with noise +3 % → asking **$1,242,000**;
inspection fee **$6,210**.

Bargain example (unit test, seed 4242, UL-1-8): a 26-year-old C208B with a disclosed
grounding defect listed at $552,000; inspect, buy, repair everything, and the 90 % resale
exceeds price + inspection + repairs.

### Pre-purchase inspection and the uninspected purchase

- `market.inspect`: fee **0.5 % of the asking price** (ledger `inspection`), done after
  **24 in-game hours**: every hidden defect becomes known (`inspection.completed` with the
  count).
- `market.buy {listingId, financing?}` (same financing rules as `fleet.buy`; collateral =
  the asking price): the aircraft is delivered where it is listed with its age, hours,
  cycles, systems and defects (hidden ones stay hidden) and a current annual. **Without a
  completed inspection** the purchase rolls (seed FNV-1a(company seed, "purchase",
  listing id)) one extra **hidden grounding defect** with chance **8 % + 1.2 % per year of
  age (≤ 45 %)**: 1 year 9.2 %, 20 years 32 %. Hidden defects surface on the first dispatch.

### Acceptance (connector, `airworthiness.test.ts`)

Seed 4242, generation 1: **UL-1-7**, a 4-year-old C208B at KYNG (medium) with nothing
disclosed, asking $2,279,000. Bought uninspected (Jetwash-financed after a loan on the
starter) it looks airworthy; the first `mission.load` at KYNG reveals the rolled interior
grounding defect and is refused with `aircraft_unairworthy` / `grounding_defect`
(`defect.found`, `aircraft.grounded`); `fleet.repairAll` at field rates (2.7M × 2.5 % × 0.4
= $27,000 × 1.35 = **$36,450**, 36 h × 1.5 = **54 h**) → `aircraft_in_maintenance` → after
54 in-game hours `repair.completed` → `mission.load` succeeds. **A used aircraft with a
grounding defect cannot be dispatched until repaired.** The ledger balances throughout.

## Storage, export, API (P5)

Migration 5 (`CREATE TABLE IF NOT EXISTS market_listings(id, generation, type_key,
location, asking_price, inspection, json)`, settings `economy.phase = 5`); fleet rows keep
their table and gain JSON fields (systems, defects, annual, ferryPermit, orders,
defectCounter, ageYears), normalised from P4 rows on load. The company record gains
`marketGeneration`, `marketRefreshedGameMs`, `orderCounter` (defaults keep P4 rows valid).
Career export **version 3** adds `market` (listings, hidden defects included, so an import
restores them); versions 1 and 2 import (an empty market is regenerated). API:
`GET /api/market` (Bearer). Demo/replay data stays in `demo.db`.

## Demo (P5)

`buildDemoCompany` also keeps a seeded market (refreshing every 7 days), inspects the
cheapest affordable listing within 600 nm on day 52, buys it financed on day 53.5, defers
its minor defects and queues the rest near the end, so the demo shows DEMO-tagged
listings, a used aircraft with defects in the systems panel and a maintenance board ETA,
with every action disabled.
