# Cargo Ops — Economy (P3 + P4 + P5 + P6 hired pilots)

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

| Rule               | Value                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destinations       | bundled OurAirports large + medium airports (MSFS data merged over them, below) ≠ origin, runway known, longest runway ≥ type minimum, surface allowed, 20 nm ≤ d ≤ 0.8 × range |
| Payload limit      | max payload − leg fuel, leg fuel = burn × (nm / cruise + 45 min)                                                                                                                |
| Short / long       | 75 % from the short band (≤ max(60 nm, 35 % of max distance)), 25 % from the long band                                                                                          |
| Destination weight | large 3, medium 2 (small 1 if ever added)                                                                                                                                       |
| Kinds (weight)     | cargo 40, express 15, fragile 12, medical 10, hazmat 8, bush 40 (bush only to unpaved or < 4,000 ft strips with a type that accepts unpaved)                                    |
| Units              | cargo 1–6, fragile 1–3, express 1–2, medical 1–2, hazmat 1–4, bush 1–4                                                                                                          |
| Weight             | payload limit × uniform share (express/medical 10–45 %, fragile 20–70 %, hazmat 20–80 %, others 25–100 %), rounded to 5 kg, ≥ 50 kg                                             |
| Time limit         | express: nm / cruise + 45 min; medical: × 1.25 + 60 min; others: × 2 + 240 min; rounded up to 5 min                                                                             |
| Board              | 24 jobs per board, wall-clock expiry 24 h, at most 4 airports' boards on offer                                                                                                  |
| Refresh            | on demand (`jobs.refresh {airport?, destination?}`), when the active type changes, and every 6 h of simulator time observed by the connector                                    |
| Focus              | `destination` puts the first 3 jobs on that airport when the type can serve it                                                                                                  |

The deadline clock starts at block-out and runs on simulator time (pauses
excluded, the tracker's clock): the connector cannot observe in-game time between
accepting and departing. A pause is the effective pause of `docs/SIMVARS.md` ("Effective
pause"): a Pause / Pause_EX1 report or the sim not running (SimStop, back to the main menu),
with a conservative rule for a pause flag that never clears.

### MSFS airport data

With a live connector and the sim running, the generator uses the airport data the player's
simulator returns (MSFS facilities, plan §6.1/§8; add-on sceneries included) merged over the
bundled OurAirports records (`packages/economy/src/facilities.ts`, connector
`src/core/facilities.ts`). Field by field:

| Field                   | From MSFS when                                                                                                     | Otherwise   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| Position, elevation     | the sim returned the airport                                                                                       | OurAirports |
| Longest runway (length) | the sim returned at least one runway (longest; ties: the first)                                                    | OurAirports |
| Surface                 | that runway's SURFACE value is in the table (docs/SIMVARS.md "Facility definition")                                | OurAirports |
| Name, type              | never for a bundled airport; an airport only the sim knows is added as **small** with the sim's name (or its ICAO) | OurAirports |

Nothing the sim did not return is filled in, and every field keeps its source ("MSFS" or
"OurAirports", shown on Jobs). The connector asks the sim per ICAO, never for bulk lists: the
board airport, the chosen destination and the 24 nearest bundled airports within the job range
when the board is opened (`jobs.list`) or refreshed, the mission airports on `mission.load`, and
the board, base and mission airports when the sim connects. Answers are cached in SQLite
(`msfs_airports`, source `msfs`, fetched-at time) and asked again after 7 days; a miss, a
timeout or a refused definition stores nothing and falls back to OurAirports (logged once).

**Determinism.** The merged list is sorted by ident and depends only on the bundled list and the
cached records, so the same seed and the same cache give the same board. New sim data never
changes a board already on offer; it is used by the next board. **MSFS data can change what jobs
an airport offers**: a runway the sim reports longer or shorter than OurAirports (or with another
surface) adds or removes that airport as a destination for a type, and an add-on airport becomes
a destination (and a board airport) once the sim has answered for it. A replay and the demo never
use MSFS data.

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
| conditions | 1 + **weather bonus** (+0.05 IFR, +0.10 LIFR from the live METAR at departure/arrival, see "Weather bonus"); night is not observed yet (needs the sim's zulu time)      |
| reputation | tier = floor(reputation / 20) → 0–5                                                                                                                                     |
| landing    | A+ 1.10, A 1.05, B 1.00, C 1.00, D 0.85, E 0.60, F 0.60 (the plan's five values over seven grades); no touchdown recorded → 1.00                                        |
| late       | 10 % of gross per late hour, pro rata, capped at 100 %; late = flight block minutes − job time limit                                                                    |
| damage     | fragile only: peak touchdown G > 1.5 → 50 % of gross. Wear/repairs are P4                                                                                               |
| noBonus    | sim rate went above 1× during the flight: conditions and reputation become 1.00 and the landing multiplier is capped at 1.00 (D/E/F penalties still apply)              |
| payload    | departure payload check `underloaded` (see "Payload check"): exactly the noBonus effect, breakdown flag `payloadMismatch`; nothing else changes                         |

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

## Weather bonus

Flying into or out of real IFR weather pays a little more. Code:
`packages/economy/src/weather-bonus.ts` (pure, shared by the connector and the browser),
applied on the payout's **conditions** line; the connector's engine freezes the weather.

- **What is recorded.** The METAR flight category (FAA VFR / MVFR / IFR / LIFR, from
  `packages/weather`) of the **origin when the mission departs** and of the **destination
  when it arrives** (Arrived: parked, engines off, brake set). Each end is frozen on the
  mission (`mission.weather.departure` / `.arrival`) with the station, the category, the
  report's origin (`live` or `sample`), the raw text, observation and fetch times, the
  telemetry `source` (`sim`, `replay`, `demo`), whether it may count, and a message. It is
  logged as `Weather (<source>) …`.
- **Where the report comes from.** The METAR the connector **already holds** for the station
  (`WeatherService.peek`): no extra request is made. Live reports exist only when the
  connector runs online and a page showing the route weather (Live Flight, the job board)
  has fetched them with **Online weather** on; otherwise the end is unknown.
- **Which reports count (all must hold).** A **live** aviationweather.gov report (never a
  SAMPLE one); **simulator** telemetry (replays and the demo never earn it); not stale (no
  failed refresh since), fetched at most **15 min** and observed at most **90 min** before
  the moment it is frozen, and neither time more than **5 min after** it (a report from the
  future is not current; small clock skew is tolerated); a known category. Anything else is
  **unknown: no bonus and no penalty**.
- **The payout re-checks every end.** An end only counts when its recorded `eligible` flag is
  true **and** it was recorded under `sim` telemetry with a `live` METAR and a known category;
  the flag alone is never trusted. A career import also clears `eligible` on any check
  (mission or transit leg) that claims it without sim telemetry and a live METAR.

| Category at an end | Bonus |
| ------------------ | ----- |
| VFR, MVFR          | 0     |
| IFR                | +5 %  |
| LIFR               | +10 % |

```
weather bonus = min(10 %, max(bonus at departure, bonus at arrival))
conditions    = 1 + weather bonus            (1.00 when bonuses are removed)
```

- The larger end counts; both ends never add up (LIFR at both ends is still +10 %).
- **Bonus-eligible flights only.** noBonus (sim rate above 1×) and an underloaded departure
  (payloadMismatch) set conditions to 1.00 like every bonus; the note says the weather bonus
  was withheld. Lateness and damage still apply to the larger gross.
- Board estimates never include it (the weather is not known in advance).
- The breakdown carries `weatherBonus` (0.05 / 0.10) when it was paid; the mission keeps
  `weather.bonus`, the fraction actually applied (0 when withheld or none). At a delivered
  arrival the connector also records `weather.outcome` (`applied`, `withheld_rate`,
  `withheld_payload`, `no_ifr`, `not_live`, or `in_transit` for a leg that delivered
  nothing), `weather.bonusFrom` (the counted end that set or would have set the bonus) and,
  on the final leg of a transit chain, `weather.chain` (the chain's counted ends and its leg
  count). The logbook shows the category at both ends and the bonus, and explains it from
  these fields only; older saves without them get no stated reason.

Worked examples (`packages/economy/test/weather-bonus.test.ts`), worked example 1 (500 kg,
100 nm, general cargo, tier 2, landing B, base $1,266.06) with weather:

1. Live IFR at departure, VFR at arrival: × 1.05 → 1,266.06 × 1.05 × 1.04 = 1,382.54 →
   **$1,383**.
2. Live IFR out, LIFR in: the larger end, × 1.10 → 1,448.38 → **$1,448**.
3. Live LIFR at both ends: still × 1.10 (cap) → **$1,448**.
4. Live LIFR with sim rate above 1× (noBonus): conditions and reputation 1.00 → **$1,266**.
5. SAMPLE LIFR at both ends, or no weather: exactly example 1 → **$1,317**.
6. Live IFR with an underloaded departure: bonus withheld → **$1,266**.

Connector (`connector/test/weather-bonus.test.ts`): the acceptance replay with the
connector's default SAMPLE weather records KMEM VFR / KATL MVFR (origin `sample`, source
`replay`) and pays $7,124 as before; a SAMPLE LIFR, a live LIFR under replay telemetry, a
stale report or no weather all pay $7,124; live IFR at KMEM and LIFR at KATL under sim
telemetry pay 6,849.98 × 1.10 × 1.04 = 7,836.38 → **$7,836**.

### Weather bonus on transit cargo

A job flown over several legs (see "Transit cargo") is paid once, at its final delivery, so
its weather bonus is decided there too. Rule (the simplest fair one; the plan is silent):

- **Recorded on the legs that actually fly.** Every leg freezes its own two ends exactly as a
  direct mission does: its origin at departure, its destination at arrival
  (`mission.weather`). A leg that only unloads cargo in transit records both checks but
  decides no bonus (`mission.weather.bonus` stays absent). Each stored job keeps the checks of
  every leg it flew (`job.transit.legs[i].weather`, no bonus field).
- **The chain's two ends count.** At the final delivery the bonus uses the **departure check
  of the first leg's origin** (from the job's first recorded leg) and the **arrival check of
  the final leg's destination**; the same eligibility rules, `max` of the two ends and the
  10 % cap apply. Intermediate stops (the transit airport's arrival on one leg and departure
  on the next) are recorded but never set the bonus, so a chain earns no more than the same
  job flown direct.
- **Only if no leg lost bonuses.** A leg flown above 1× (noBonus) or departed underloaded
  (payloadMismatch) removes every bonus of the final payout, the weather bonus included (the
  note says it was withheld), as for any transit bonus.
- **Older legs.** A first leg flown before the weather bonus existed has no recorded
  departure check: only the final arrival can count (nothing is inferred).
- Code: `chainWeather` / `finalDeliveryTerms` in `packages/economy/src/transit.ts`. With jobs
  from different chains on one leg, each job's breakdown carries its own `weatherBonus` and
  the mission's `weather.bonus` shows the largest one paid.

Examples (`packages/economy/test/transit.test.ts` "weather bonus on transit cargo",
`connector/test/weather-transit.test.ts` on the synthetic KMEM → KATL → KRDU legs with
sim-stamped test frames and hand-made live reports):

1. KMEM IFR at the first departure, KATL LIFR at the stop, KRDU VFR at the final arrival:
   **+5 %** from KMEM; the KATL LIFR is recorded on both legs and never counts.
2. KMEM VFR, KATL VFR, KRDU LIFR: **+10 %** from the final arrival.
3. KMEM VFR, KATL LIFR, KRDU MVFR: **no bonus** (only the stop was IFR/LIFR).
4. KMEM IFR with leg 1 flown above 1×: bonus **withheld** at the final delivery.

## Mission lifecycle and verification (plan §6.4)

`accept → load → start → verify leg → deliver → payout`

- **accept / release**: available ↔ accepted (max 20 accepted). Expired jobs leave
  the board.
- **load** (`mission.load {jobIds, destination?}`): one open mission at a time; all jobs
  accepted (or in transit) and at the same airport, sharing their destination (stacked
  cargo) unless a leg `destination` is given (see "Transit cargo"); destination runway
  suits the active type; leg distance ≤ 80 % of range; total weight ≤ max payload − leg
  fuel.
  `mission.unload` returns the jobs to accepted before departure.
- **payload check**: cargo vs the sim's payload stations, previewed while loaded and frozen at
  the start; an underloaded departure pays without bonuses (see "Payload check").
  `mission.load {enteredPayloadKg?}` or `mission.payload {kg | null}` (before departure;
  `mission_in_progress` after it) records a payload entered by you (see "Payload entered by
  you").
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
  restart) → mission `aborted`, jobs back to accepted (transit cargo back at its stop,
  clock unchanged), no penalty. A `mission.abort` while the flight is still running
  aborts the mission at once, but the aircraft stays `in_flight` until that flight ends;
  then the flight's real costs (fuel at the parking airport's price, the landing fee where
  it parked, lease hours) and wear are booked on the aborted mission (`mission.costs`) and
  the aircraft is released where it parked. No payout, no reputation change (a crash on
  that flight is settled as a crash, without the −20: no cargo was being flown for pay).
  An aborted mission keeps only its departure weather check: no arrival is frozen and no
  weather bonus is decided.
- **connector restart**: a fresh connector has no running flight and the tracker's
  in-memory leg (distance, fuel, landings) is gone, so a lost flight is never resumed or
  billed. At startup every aircraft left `in_flight` (mission, ferry or an aborted flight)
  is available again, and a mission left `in_progress` goes back to `loaded` (its start,
  flown distance, departure payload check and departure weather check cleared; the next
  departure freezes a fresh METAR check). The first sample decides: on the
  ground within **3 nm** of the origin → it stays loaded and flies normally from the next
  departure; otherwise (airborne or elsewhere) → `aborted` (failure code
  `flight_lost`), jobs back to accepted / transit cargo back at its stop, no penalty.
  `mission.recovered {missionId, status}` is emitted either way.

Reputation (0–100, start 50): on time with landing A+/A **+3**, B **+2**, C or no
grade **+1**; landing D/E/F **−5**; **−3 per started late hour** (and no clean
bonus when late); crash **−20**.

## Payload check

Compares the cargo a loaded mission requires with what the simulator says is on board.
Code: `packages/economy/src/payload-check.ts` (pure, shared by the connector and the browser
UI), constants in `constants.ts`; the connector's engine feeds it the latest `payload` and
`weights` domains.

```
sim payload = Σ PAYLOAD STATION WEIGHT:1..n (pounds → kg)
crew        = player setting, else the FIRST pilot seat + every crew seat, else 0 kg
              pilot seat: whole trimmed name Pilot / Co-pilot / Copilot / Captain /
                          First Officer (optional " Seat", optional number)
              crew seat:  whole trimmed name Crew (optional " Seat", optional number)
loaded      = max(0, sim payload − crew)
tolerance   = max(25 kg, 10 % of the cargo)
```

| Status        | Rule (first match wins)                                                                     | Effect                                                         |
| ------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `overloaded`  | the sim reports TOTAL WEIGHT and MAX GROSS WEIGHT (> 0) and total > max gross               | warning; an explicit start is refused (`over_mtow`, unchanged) |
| `unknown`     | the sim reported no payload stations (none, rejected SimVars, or `PAYLOAD STATION COUNT` 0) | none: nothing is compared, **never a penalty**                 |
| `underloaded` | loaded < cargo − tolerance                                                                  | warning before departure; at departure: payout without bonuses |
| `ok`          | otherwise (more payload than cargo is fine: extra weight is the pilot's choice)             | none                                                           |

- **When.** While the mission is `loaded` the check is a live **preview** (recomputed on every
  sample, shown on the mission strip of /jobs, /flight and the dashboard). When the mission
  starts (explicit `flight.start`, or automatically at takeoff) the check is frozen on the
  mission as stage **departure**, logged, and announced with a `mission.payload_check`
  event (`{missionId, flightId, check, payoutBonuses}`). Changing the load after departure
  does not change it.
- **Effect (the gentlest rule that fits the existing economy).** An underloaded departure
  is not refused and costs no reputation. The delivered payout loses its **bonuses**, exactly
  like the existing noBonus rule: conditions and reputation 1.00, landing capped at 1.00
  (penalties still apply). Each job breakdown carries `noBonus: true` and
  `payloadMismatch: true`. A preview never affects money.
- **Source.** The check records where the telemetry came from (`sim`, `replay`, `demo`);
  the UI labels replay/demo checks. Replays use the recorded payload stations.
- **Crew allowance.** Many aircraft load the pilot in a payload station, so it is subtracted
  before comparing. Every doubt favours the player:
  - names must match the **whole** station name, so "Pilot Baggage", "Crew Baggage", cargo
    bags and compartments are always cargo;
  - only the **first** pilot seat counts as crew. A second seat ("Copilot", "First
    Officer") is ambiguous: in a cargo flight it often holds cargo, so it counts as payload.
    A real second pilot makes the check more generous, never harsher; set the crew
    allowance if you want it subtracted;
  - with **no** crew-named station nothing is subtracted (0 kg): a pilot the sim does not
    report is never assumed. `settings.update {crewAllowanceKg: kg | null}` (0–2,000 kg; null =
    automatic) sets it for the company; the /jobs page has a field for it.
- **Logbook.** The departure check is stored with the mission; the logbook row shows it and
  the CSV export has a `payload_check` column (`ok`, `underloaded`, `overloaded`, `unknown`,
  empty without a mission).

### Payload entered by you

Legacy `PAYLOAD STATION*` SimVars can be missing or wrong on MSFS 2024 aircraft (plan §14.2).
The player may type the payload for the loaded mission (kg, the cargo loaded, crew excluded;
0–200,000): `mission.load {jobIds, enteredPayloadKg}` at load or `mission.payload {kg}` before
departure (`kg: null` clears it; frozen at departure). It is stored on the mission
(`enteredPayloadKg`) and shown everywhere as **entered by you** (tag `YOURS`, source
`player`), never as a sim value. The rule never pays for a player number:

| Station readout              | Entered value                                                     | Status                                                  | `enteredRole` |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| reported (ok or underloaded) | same verdict as the sim                                           | the sim's                                               | `agrees`      |
| reported (ok or underloaded) | other verdict                                                     | the sim's: the entered value is **ignored**             | `contradicts` |
| none (`unknown`)             | any                                                               | `unknown`: bonuses kept, no penalty (the existing rule) | `used`        |
| none (`unknown`)             | EMPTY WEIGHT + fuel + (entered + crew setting) > MAX GROSS WEIGHT | `overloaded`, `overBasis: "entered"`: a warning only    | `used`        |

- An entered value can only stand in for an `unknown` readout. It can never turn an
  underloaded sim reading into a bonus-eligible `ok`, and it can never make a check
  `underloaded` (no penalty from the player's own number either), so `payloadMismatch` depends
  on the sim alone.
- The entered-value overload is a caution: an explicit start is refused only by the sim's own
  TOTAL WEIGHT (`over_mtow`, `overBasis: "total_weight"`), never by an entered number.
- "Verdict" uses the same tolerance: short = below cargo − max(25 kg, 10 % of the cargo).

### TOTAL WEIGHT cross-check

```
implied   = TOTAL WEIGHT − EMPTY WEIGHT − FUEL TOTAL QUANTITY WEIGHT   (pounds → kg)
compared  = Σ PAYLOAD STATION WEIGHT (crew included)
            or, with no stations, the entered value + the crew setting (else 0 kg)
tolerance = max(100 kg, 10 % of implied)
```

Only when the sim reports all three weights and implied ≥ 0 (a negative remainder means the
sim's numbers disagree; nothing is shown instead of a made-up 0). The check records
`impliedKg`, `emptyLb`, `fuelLb`, `crossCheck` (`match` / `mismatch`), `crossCheckWith`
(`stations` / `entered`) and `crossCheckToleranceKg`; a mismatch is appended to the message
and flagged in the UI. It is informational: it never changes the status or the payout. The
100 kg floor covers a pilot the sim does not list as a station, oil and unusable fuel. Replay
fixture: 8,430 − 4,730 − 1,700 = 2,000 lb = 907.2 kg = the station sum → `match`.

The logbook row and detail show both sources; the CSV export adds `payload_entered_kg` and
`payload_implied_kg` after `payload_check`. Both live inside the mission and its payload check,
so the career export stays version 5 (optional fields; older files import unchanged).

Worked examples (`packages/economy/test/payload-check.test.ts`), stations of the replay
fixture (Pilot 170 lb + 450 + 520 + 480 + 380 lb = 2,000 lb):

1. 2,000 lb × 0.45359237 = **907.2 kg**; crew = Pilot 170 lb = **77.1 kg**; loaded
   **830.1 kg**. Cargo 840 kg, tolerance 84 kg: 830.1 ≥ 756 → **ok** (the replay
   acceptance mission pays $7,124 as before).
2. Same stations, cargo 950 kg, tolerance 95 kg: 830.1 < 855 → **underloaded**.
3. A single "Cargo" station with 441 lb (200.0 kg) for 200 kg of cargo: no crew seat → crew
   0 kg → loaded 200.0 kg → **ok** (an assumed pilot would have made it 122.9 kg, wrongly
   underloaded).
4. "Pilot" 170 lb, "Pilot Baggage" 100 lb, "Copilot" 300 lb (cargo in the seat), "Cargo"
   500 lb: crew = the Pilot seat only (77.1 kg); baggage and the copilot seat are payload →
   loaded 1,070 lb − 170 lb = 900 lb = **408.2 kg**.
5. The acceptance job (840 kg, $7,124 with bonuses) flown with 50 lb in each cargo station
   (370 lb = 167.8 kg, loaded 90.7 kg) → underloaded at departure → 6,849.98 × 1.00 →
   **$6,850**; reputation still +2 for the on-time B landing
   (`connector/test/economy.test.ts`).

## Route finder

Exhaustive depth-first search from the current board airport over every job on
offer (all boards plus accepted jobs), at most 3 legs, never revisiting an airport.
Each leg stacks its same-route jobs greedily by payout per kg within the leg's
payload limit. Chains are ranked by total estimated payout (then fewer legs, then
shorter). Multi-hop chains need boards at the intermediate airports (refresh a board
there). The finder plans single-leg jobs only: long-haul jobs and cargo already in
transit are left out (plan their stops with "Leg to", see below).

## Transit cargo

A job whose final destination lies beyond the next leg can be flown to an intermediate
airport, unloaded there **in transit** (stored at that airport) and picked up later for the
onward leg. Code: `packages/economy/src/transit.ts` (pure rules shared with the UI), the
engine's `load` / delivery path, constants in `constants.ts` and `fbo-constants.ts`. The
plan does not specify transit cargo, so these are the simplest rules consistent with the
rest of the economy:

| Rule            | Value                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transit leg     | `mission.load {jobIds, destination}` with a `destination` other than a job's final destination. The leg starts where the cargo is (its origin, or its transit stop); all jobs must be there (`mixed_route`)                                                                                                                                                                                                                |
| Stacking        | without `destination` the jobs must share their final destination (as before); with it, jobs going there are delivered and the others go on in transit (`mission.transitJobIds`)                                                                                                                                                                                                                                           |
| Progress        | the leg must end strictly closer (great circle) to every onward job's final destination than where the cargo is now (`no_progress`); a leg to the same airport is `same_airport`                                                                                                                                                                                                                                           |
| Per-leg checks  | unchanged and per leg: range, runway, payload limit (max payload − leg fuel, − major-defect penalty) over everything on board, airworthiness, start at the origin, fuel, MTOW, payload check, leg verification                                                                                                                                                                                                             |
| Payout          | **full payout on the final delivery only** (job origin → destination great circle, kind, units, board demand factor, current reputation, landing grade of the final leg); intermediate legs pay nothing; never partial credit                                                                                                                                                                                              |
| Deadline        | the job's time limit covers the **whole chain**: Σ block minutes of every leg + ground time between legs on the company clock − free storage minutes; late minutes at the final delivery use the normal late penalty                                                                                                                                                                                                       |
| Bonuses, damage | a leg flown above 1× (noBonus) or departed underloaded removes the bonuses of the final payout; a fragile touchdown above 1.5 G on **any** leg damages it                                                                                                                                                                                                                                                                  |
| Weather bonus   | every leg records its own departure/arrival METAR checks; the final delivery uses the **first leg's departure** and the **final leg's arrival** (see "Weather bonus on transit cargo")                                                                                                                                                                                                                                     |
| Reputation      | a leg with at least one final delivery: the normal rule over those jobs; a leg that only carried transit cargo: 0, except a hard landing (D/E/F) −5                                                                                                                                                                                                                                                                        |
| Failure         | a crash or a failed verification fails every job on board (no partial credit). Cargo already stored on an earlier leg and lost by a failed **non-crash** verification (wrong airport, short distance, teleport, > 8×) counts as abandoned: **−3** reputation each and `job.abandoned`, exactly like `job.release` (a crash already costs −20). Abort / unload puts transit cargo back at its stop with its clock unchanged |
| Abandon         | `job.release` of an in-transit job: failed, no payout, reputation **−3** (`job.abandoned`)                                                                                                                                                                                                                                                                                                                                 |
| Storage         | at an airport without an own FBO: no benefit; own operating FBO: none either; own **cargo terminal** L1 / L2 / L3: the first **4 / 8 / 12** ground hours at that stop do not count against the deadline                                                                                                                                                                                                                    |
| Leg deadline    | a loaded leg's `timeLimitMin` is the tightest time left among its jobs (negative = already late, never clamped), recomputed every in-game minute while the stored cargo waits and frozen at block-out; `expectedPayout` sums the jobs delivered on the leg, stored ones with the late penalty accrued so far                                                                                                               |
| Long-haul jobs  | every connector board adds **2** jobs beyond one leg's direct range (80 % of the range) up to 2 × that, tagged `longHaul` ("Needs a stop"), only when a chain of legs that passes every load rule exists (below)                                                                                                                                                                                                           |

```
chain minutes       = Σ leg block minutes + Σ max(0, ground minutes at each stop − free storage minutes)
late (final leg)    = chain minutes − job time limit            (≤ 0 = on time)
deadline at a stop  = arrival company clock + (time limit − chain minutes so far + free storage minutes)
```

**Long-haul jobs.** Drawn after every other job of the board from their own seeded stream
(seed FNV-1a(board seed, "long-haul")), so the regular jobs of a board never change.
Destinations: runway suitable, `0.8 × range < d ≤ 1.6 × range`, weighted large 3 / medium 2,
and **deliverable**: `longHaulRoute` must find a chain in which every leg is within the direct
range, ends at a suitable runway, ends strictly closer to the destination and carries at least
50 kg (the rules `mission.load` enforces). The search is a deterministic DP over the airports
closer to the destination than the origin, inside the corridor origin → stop → destination ≤
**2 ×** the direct distance; among chains the fewest legs win, then the best worst leg, then
the shortest. A drawn destination without a chain leaves the pool and the stream draws again
(seed 4242-style boards keep their regular jobs byte-identical). Examples (C208B): LPLA →
EIKY has no progressing chain over the Atlantic and is never offered (49 of the 301
pre-filtered LPLA destinations are dropped); KMEM → KMIA goes KMEM → KPAM → KMIA (752.4 nm).
A `jobs.refresh {destination}` beyond the direct range puts the first long-haul job there when
it is deliverable. Kind and units as usual; weight drawn against the payload limit of the
chain's **worst leg**; time limit = the usual limit for the chain's flown distance + **60 min
per stop**. The browser demo board has none (it stays the 24-job P3 board).

**UI.** `/jobs` lists stored cargo with its stop, final destination, due time on the company
clock and time left ("time left unknown" before the company clock is known; nothing is
guessed), the payout estimate with the late penalty accrued so far, and Abandon behind a
confirmation dialog. The mission strip shows a leg already late as "… late already".

**Events.** `job.in_transit {jobId, missionId, location, destination, storage,
deadlineGameMs}` when cargo is stored; `job.completed` only on final delivery;
`job.abandoned`. The jobs domain gains `inTransit` (each job carries `transit`: location,
arrival time and company clock, chain minutes so far, storage, free minutes, deadline and
every flown leg with its block and ground minutes, grade, peak G, bonus flags and the weather
checks frozen on it).

### Worked examples (`packages/economy/test/transit.test.ts`)

1. General cargo, 500 kg, KMEM → KRDU (549.2 nm), limit 549.2 / 170 h × 2 + 240 = 627.7 →
   **630 min**. Leg 1 KMEM → KATL, block 119 min, stored at the KATL ramp: chain 119, deadline
   arrival + **511 min**. Two hours on the ground → 239 used, 391 left. Leg 2 KATL → KRDU,
   block 125: chain 119 + 120 + 125 = **364 min**, on time. Payout 0.015 × 500 × 549.2 ×
   1.9420812 = **$7,999.43** × 1.04 (tier 2) × 1.00 (B) = $8,319.41 → **$8,319**, exactly the
   board estimate, paid once, on leg 2. The late line notes "transit chain of 2 legs,
   364.0 min incl. ground time".
2. Express, 200 kg, same route, limit 193.8 + 45 → **240 min**, 150 min at KATL. Public ramp:
   119 + 150 + 125 = 394 → **154 min late** → 25.67 % of $4,991.65 → −$1,281.19 → **$3,710**.
   In an own cargo terminal L1 (4 h free) the 150 min do not count: 244 → **4 min late** →
   −$33.28 → **$4,958**; the stored job's deadline is arrival + (240 − 119 + 240) min.
3. Fragile, 300 kg, landed at 1.62 G on leg 1 and 1.10 G on leg 2: damaged (worst touchdown
   of the chain) → 50 % of $6,489.14 → **$3,245**.

### Acceptance (connector replay, `connector/test/transit.test.ts`)

Seed 4242: a KMEM → KRDU job (focused board) loaded with `destination: "KATL"` and flown by
the synthetic KMEM → KATL replay: mission delivered with payout **$0** and only fuel and the
landing fee booked; reputation unchanged (on-time B, no delivery); the job is `in_transit` at
KATL (jobs row `location = KATL`), elapsed = the leg's block minutes. After a restart on the
same database the job is still there; two in-game hours later it is loaded at KATL (mission
origin KATL, destination KRDU) and flown by a **SYNTHETIC** KATL → KRDU leg — the same fixture
re-projected onto that route (`connector/test/transit-leg.ts`), not a recording — and paid
`computePayout` over the full 549.2 nm with the chain minutes (block 1 + 120 + block 2):
one `mission_payout` row, reputation +2, the ledger balances. With an own KATL FBO and a
cargo terminal L1 the stored job shows `own_terminal`, 240 free minutes: 3 h at the stop
cost nothing, 5 h cost 60 min. Long-haul: the KMEM board has 26 jobs, 2 long-haul; a KMIA
job (747.4 nm > 720) is refused direct (`out_of_range`) and loads via KATL. A crash on a
transit leg fails the job; abandoning stored cargo costs 3 reputation, and so does losing it on
an onward leg flown to KCLT instead of KRDU (`short_distance`, `job.abandoned`). A stored job
kept 90 min past its limit: the onward leg loads with `timeLimitMin` −90 and the expected
payout with that late penalty, both follow the clock while it waits (−120 after 30 more
minutes) and freeze at block-out.

### Storage and export

Migration **8**: `jobs.location` (the airport the cargo is at now; existing rows get their
origin) and an index on `(location, status)`; settings `economy.phase = 8`. The transit
record lives in the job row's JSON. Career export **version 5** may contain `in_transit`
jobs, long-haul jobs and missions with `transitJobIds`; versions 1–4 import unchanged (they
have no transit cargo), and an older connector refuses a version 5 file rather than misread
it. The weather checks (`mission.weather`, `job.transit.legs[i].weather`) and the
breakdown's `weatherBonus` are optional fields of the same mission and job JSON: a version 5
export carries them and imports them unchanged (no format bump; tested in
`connector/test/weather-transit.test.ts`), and v5 files without them import as before.

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
  expense = negative ones. The last 24 months are kept on the company record; a company
  with ledger rows but no P&L (a P3 database, an import) gets it rebuilt from the ledger.
- A delivered mission's `payout.total`, cost total and `net` are summed in cents
  (`missionPayoutTotals`), so they equal the `mission_payout` / cost ledger rows exactly.
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
4× (simulator Δ comes from the flight core's sim clock, which stops while paused or
stopped in the main menu); a
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
recomputed, the monthly P&L rebuilt from the imported ledger, starter aircraft granted on
reload). API: `GET /api/ledger`,
`/api/fleet`, `/api/loans` (Bearer token; see `connector/README.md`).

## Demo

`buildDemoCompany(lookup)` runs a fixed script on the same book (17 KMEM/KATL/KBNA/KSDF/
KLIT deliveries priced with `computePayout`, a $400,000 Jetwash loan on the starter on
day 20.5, a dry-leased Kodiak on day 24) to day 77.6. Every value it produces is shown
tagged DEMO with all actions disabled.

## Deferred

- Done in P5 part 2 (below): FBOs, insurance, dynamic demand and fuel prices, milestones.
  Still open: the night condition bonus, small/GA airports. The IFR/LIFR weather bonus and
  transit cargo are done (see "Weather bonus" and "Transit cargo").
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

---

# P5 — FBOs, demand, insurance, milestones

Code: `packages/economy/src/{fbo-constants,fbo,demand,insurance,milestones}.ts` and the P5
part 2 section of `book.ts` (pure, seeded, shared by the connector and the browser demo);
the connector's `core/economy/engine.ts` (commands, board hooks, AI traffic) and
`sim/ai-traffic.ts`; protocol `packages/protocol/src/fbo.ts`. Every constant lives in
`fbo-constants.ts`. Worked examples are unit tests in `packages/economy/test/fbo.test.ts`
and `connector/test/fbo.test.ts`.

## Airport size, buy and build (plan §7.3)

The bundled OurAirports subset has no `scheduled_service` column and no runway count: the
**longest runway** stands in for runway capacity and an **IATA code** for scheduled service.

```
s           = type base × runway factor × service factor                 (4 decimals)
type base   = large 1, medium 0.35, small 0.15
runway      = clamp(longest runway / 8,000 ft, 0.4, 1.6)   (unknown → 0.4)
service     = 1 with an IATA code, else 0.6
buy price   = $500,000 × s, rounded to $1,000   (comes with ramp & services 1 + fuel farm 1)
build       = 55 % of the buy price now + land lease 0.4 % of it per in-game month,
              ready after round(3 + 11 × clamp((s − 0.15) / 1.45, 0, 1)) in-game days
              (comes with ramp & services 1)
book value  = 85 % of the money invested (price + modules);  sale = 75 % of it
```

One FBO per airport (`fbo_exists`), any number of airports. Loans may finance a purchase
or a construction (collateral `{type: "fbo"}`, value = the price; later loans use the book
value); a repossessed FBO leaves the portfolio. Selling pays off a loan on it first
(`underwater` otherwise) and books the day's accrued traffic.

| Airport | Type, runway, IATA    | s      | Buy      | Build (+ lease/mo)  | Days | Movements/day |
| ------- | --------------------- | ------ | -------- | ------------------- | ---- | ------------- |
| KATL    | large, 12,390 ft, ATL | 1.5488 | $774,000 | $425,700 (+ $3,096) | 14   | 77.1          |
| KMEM    | large, 11,120 ft, MEM | 1.39   | $695,000 | $382,250 (+ $2,780) | 12   | 65.6          |
| KLIT    | medium, 8,273 ft, LIT | 0.3619 | $181,000 | $99,550 (+ $724)    | 5    | 8.7           |

KATL: 1 × 12,390 / 8,000 × 1 = 1.5488 → 500,000 × 1.5488 = $774,400 → **$774,000**; build
774,000 × 0.55 = **$425,700**, lease **$3,096**, 3 + 11 × (1.3988 / 1.45 → 0.9647) = 13.6 →
**14 days**.

## Modules (levels 1–3)

Cost of each level and monthly upkeep × the size scale **clamp(s, 0.4, 1.2)**; installing or
upgrading takes in-game days (shown on the queue with an ETA) and the new level works when it
completes. Upkeep (and a built FBO's land lease) is billed at every month boundary for the
coming month (`fbo_upkeep`); the month of acquisition is free.

| Module           | Cost L1 / L2 / L3  | Upkeep/mo L1 / L2 / L3 | Days  | Effect by level                                                                                                                                                                             |
| ---------------- | ------------------ | ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fuel farm        | 120k / 180k / 300k | 3,000 / 5,000 / 8,000  | 1/2/4 | cost = regional price × (1 − 6/9/12 %); sells ≤ 20,000 / 60,000 / 150,000 kg a day; buy chance 45/55/65 %; own aircraft fuel at cost                                                        |
| Hangar           | 150k / 200k / 300k | 2,500 / 4,000 / 6,000  | 2/3/5 | 2 / 4 / 8 bays; own aircraft inside lose 60 / 80 / 100 % less storm wear; spare bays rented nightly with 45 / 60 / 75 % chance at $90 × scale                                               |
| Maintenance shop | 200k / 250k / 400k | 5,000 / 8,000 / 12,000 | 2/3/5 | own repairs × 0.75 cost, × 0.7 time up to minor / major / grounding defects; services traffic (2.5 / 5 / 7.5 %, $600 × class margin)                                                        |
| Cargo terminal   | 180k / 220k / 350k | 4,000 / 6,000 / 9,000  | 2/3/4 | +4 / 8 / 12 jobs and +5 / 10 / 15 % payouts on boards at the airport; cargo handling of traffic (8 / 16 / 24 %, 1.2 × handling fee); transit cargo stored 4 / 8 / 12 h free of its deadline |
| Ramp & services  | 60k / 100k / 160k  | 1,500 / 2,500 / 4,000  | 1/1/2 | captures 30 / 38 / 46 % of the airport's movements; landing/parking $15 × class × 1 / 1.15 / 1.3; handling 25 / 32 / 40 %; L2+ crew lounge                                                  |

At KATL (scale 1.2): fuel farm L1 **$144,000**, upkeep **$3,600**/mo; a bought KATL FBO pays
ramp $1,800 + fuel farm $3,600 = **$5,400** a month. At KLIT (scale 0.4): fuel farm L1 $48,000.

**Own maintenance shop** (`MaintenanceCapability`): an airport with an operating own shop of
any level is maintenance-capable (ferry permits target it, annuals there use own rates); a
repair uses `own` rates (× 0.75 cost, × 0.7 time) when the shop's level covers every defect's
severity, else the airport's normal rates. Example (KLIT, L1): gear minor $4,860 / 8 h →
**$3,645 / 5.6 h**; a grounding defect there is not covered → field rates $67,500 × 1.35 =
**$91,125 / 90 h**.

## Income source 1: the player's own arrivals

On a flight that lands and parks at an airport with an own operating FBO (any settled
mission or ferry leg):

- **fuel at cost** with a fuel farm: billed at the farm's cost price instead of the regional
  price; the difference is an `fbo_transactions` row (`fuel_at_cost`, source `own`);
- **landing fee waived** (you own the ramp): the mission cost line shows $0, the fee is an
  `own` transaction (`landing_fee_waived`);
- **crew lounge** (ramp ≥ 2): +1 reputation, at most once per in-game day per FBO.

Own-arrival benefits are savings, not cash: they are charted and kept in the FBO P&L
(`savings`), never in the ledger.

**Acceptance (connector, `connector/test/fbo.test.ts`)**: seed 4242; `fbo.buy KATL` financed
by Jetwash ($600,000, 60 months): cash 250,000 − 774,000 + 600,000 − 6,000 (fee) = $70,000.
The replayed KMEM→KATL mission still pays **$7,124** (no demand on day 0, no terminal at
KMEM); its 623.1 lb = 282.63 kg are billed at the farm's **$1.800/kg** (6 % under KATL's
$1.915) = **$508.74** instead of $541.24 → `fuel_at_cost` **$32.50**; the **$300** landing fee
is waived → `landing_fee_waived` $300; today's own savings **$332.50**; cash
70,000 + 7,124 − 508.74 = **$76,615.26**; the ledger balances.

## Income source 2: the modelled traffic stream

A deterministic stream per FBO airport on the company clock, one in-game hour at a time:

```
movements/day M = 40 × s^1.5              hour weights w_h (night 0.1–0.25, peaks 1.8; Σ = 24)
λ_h             = M × w_h / 24             n = ⌊λ⌋ + (rng < λ − ⌊λ⌋)
seed            = FNV-1a(company seed, "traffic", ICAO, absolute hour)
class mix       = large: piston 20 / turboprop 40 / jet 40 %; medium 50 / 40 / 10 %
class factor    = piston 0.5, turboprop 1, jet 3;  fuel uplift 120 / 500 / 2,000 kg
per movement    captured with the ramp share, then (independent draws, every draw made
                for every movement so a module change never shifts the stream):
  ramp fee      $15 × class × ramp level factor                         (always)
  handling      chance × e(H / $80) → H × class                         (H = player fee)
  fuel          chance × e(r)       → uplift × (P − farm cost), ≤ daily capacity
  cargo         chance × e(H / $80) → 1.2 × H × class                   (terminal)
  maintenance   chance              → $600 × class                       (shop)
night           spare hangar bays rented (seed FNV-1a(seed, "hangar", ICAO, day))
```

**Price elasticity** (too-high prices lose customers):

```
e(r) = clamp(1 − 3 × (r − 1), 0, 1.3)        r = player price ÷ reference
r:   0.9 → 1.30   1.0 → 1.00   1.05 → 0.85   1.1 → 0.70   1.2 → 0.40   1.3 → 0.10   ≥ 1.34 → 0
```

The fuel price is set as a ratio of the airport's regional price (0.7–1.5, so it follows
demand events); the handling fee in dollars ($20–$300, reference $80 per turboprop). With a
farm cost c = 0.94 (L1) the fuel margin per customer (r − c) × e(r) peaks at
r = (4 + 3c) / 6 = **1.137**.

The day's modelled income is posted at the in-game midnight as **one `fbo_income` ledger
entry** per FBO, with one `fbo_transactions` row per kind (source `modelled`), and charted.

Worked example (KATL, ramp 1 + fuel farm 1, reference prices, regional $1.915, farm cost
$1.800, margin $0.115):

```
average class factor   0.2 × 0.5 + 0.4 × 1 + 0.4 × 3 = 1.7
average uplift         0.2 × 120 + 0.4 × 500 + 0.4 × 2,000 = 1,024 kg
per captured movement  ramp 15 × 1.7 = 25.50 + handling 0.25 × 80 × 1.7 = 34.00
                       + fuel 0.45 × 1,024 × 0.115 = 52.99  → $112.49
expected per day       77.1 × 0.30 × 112.49 = $2,601.94   (≈ $78,000 a month vs $5,400 upkeep)
```

Seeded day 1 at KATL (seed 4242, hours 24–47): 77 movements, 20 captured, ramp $540,
handling $160, fuel $1,035 (9,000 kg) → **$1,735.00**. Over 30 days the seeded mean stays
within ±15 % of the expected value (unit test). KLIT (medium) with the same modules expects
$151.61 a day: small FBOs mostly pay off through your own operations (fuel at cost, fees,
the shop and the terminal).

## Income source 3: real AI traffic in the simulator (bonus)

`connector/src/sim/ai-traffic.ts` (unverified on a real sim; type-checked against
node-simconnect 4.2.1):

- Every **30 s**, while an own FBO airport lies within reach, `requestDataOnSimObjectType`
  asks for every `AIRCRAFT` object around the **user aircraft** (SimConnect centres the radius
  on the user; maximum 200 km): radius = distance to the farthest FBO in reach + 10 km. The
  definition reads `PLANE LATITUDE`, `PLANE LONGITUDE`, `SIM ON GROUND`, `GROUND VELOCITY` and
  `ATC ID`; `simObjectDataByType` replies are collected until entry `outOf`.
- **Arrival** = an object within **10 km** of the FBO airport, on the ground and slower than
  **30 kt**, that the detector saw moving (airborne or faster than 40 kt) inside that radius,
  and whose object id was not credited there in the last 6 hours. Aircraft first seen parked
  (gate spawns) never count.
- **Bonus** (`fbo_income` at once, transaction source `sim_ai`, memo "AI arrival observed in
  the simulator (bonus …)"): ramp fee $15 × ramp factor + handling H × e(H/80) (+ 400 kg ×
  fuel margin × e(r) with a farm), turboprop class. KATL ramp 1 + fuel farm 1 at reference
  prices: 15 + 80 + 400 × 0.115 = **$141**.

The economy works fully offline; this is a labelled bonus only. Replays never emit it
(`FakeAiTraffic` scripts batches for tests).

## Dynamic demand (plan §7.4)

```
index(airport) = max(0.5, 1 + activity + active event payout uplift)
job factor     = clamp((index(origin) + index(destination)) / 2, 0.8, 1.5)   (2 decimals)
                 × (1 + own cargo terminal bonus at the origin)
fuel price     = regional price × (1 + active event fuel uplift)
activity       delivery into an airport −0.03, departure with cargo +0.01, clamped to
               −0.15…+0.10, decays × 0.85 per in-game day
```

The factor is fixed on the board (`job.demandFactor`, a "Local demand" line in the
breakdown) and the delivered payout uses the same factor; a factor of 1 adds no line, so
P3–P5 payouts are unchanged.

**Events**: at the start of every in-game day ≥ 1, seed FNV-1a(company seed, "demand", day):
50 % chance of one new event at an airport without an active one, among large airports
within 600 nm of the base plus the FBO airports (weight large 3, medium 1):

| Event    | Weight | Days | Payouts | Fuel  | Other                                            |
| -------- | ------ | ---- | ------- | ----- | ------------------------------------------------ |
| Storm    | 45     | 1–3  | +20 %   | +8 %  | aircraft parked outside lose 0.4 condition a day |
| Festival | 30     | 2–4  | +12 %   | +4 %  | —                                                |
| Strike   | 25     | 2–5  | +30 %   | +15 % | —                                                |

Examples: two deliveries into KATL → activity −0.06 → index **0.94**; a storm there →
**1.14**; a KMEM→KATL job then gets (1 + 1.14) / 2 = **1.07**. Seed 4242 with base KMEM (43
candidates): the first event is a **storm at KIND on day 3**, one day long (`EV-3-KIND`); a
C208B parked there loses 0.4 → **99.6 %**, inside an own hangar L1 0.16 → **99.84 %**. Events
show on `/jobs` and as map pins (`demand.event`).

## Hull insurance (plan §7.4)

```
premium/month = 0.3 % × hull value × risk                   (first month at purchase)
risk          = min(3, 1 + 0.25 × hard landings (peak G > 1.6) in 180 days
                       + 1 × crashes in 360 days)
repair claim  = 80 % × max(0, incident repair cost − $2,000)   (defects caused by a hard
                landing or a crash, at the shop's rates; claimed when the repair is ordered)
write-off     = 80 % × the hull value just before the crash
```

A new C208B ($2.7M value): **$8,100**/month; after one hard landing × 1.25. A $19,440 hard
landing gear repair at KMEM pays **$13,952**. **An insured write-off settles its loan from
the payout** (`loan_payment` up to the balance; the loan is `paid_off` when covered, else the
rest stays active); an uninsured write-off keeps the loan active, as in P5 part 1. Ledger:
`insurance` (premiums), `insurance_claim`; event `insurance.claim`. Owned aircraft only
(`not_owned`); `insurance.cancel` stops the next premiums (no refund) and is refused with
`repair_loan_open` while an insurer repair loan on the aircraft is open (below). With a
repair loan open, the write-off payout nets that loan off **first** and settles the bank loan
from the rest.

## Insurer repair loans (plan §7.4)

The policy's "repossession-free repair loans": an insured aircraft can have its repair bill
financed by the insurer. Code: `packages/economy/src/insurance.ts` (`repairLoanCheck`,
`repairLoanBill`, `repairLoanTerms`, constants `REPAIR_LOAN` in `fbo-constants.ts`) and
`CompanyBook.repairLoan`; tests `packages/economy/test/repair-loans.test.ts` (rule matrix and
book) and `connector/test/repair-loans.test.ts` (through the session and SQLite).

```
bill     = repair cost − the incident claim the policy pays on it      (≥ 0, cents)
APR      = 4 % fixed (the cheapest bank starts at 5.5 %), no origination fee
term     = 6–24 in-game months; amount $500 … bill
payment  = standard amortisation (same formula and rounding as bank loans)
```

- **Command** `insurance.repairLoan {aircraftId, repair: overhaul|all|defect, defectId?,
principal, termMonths}` orders the repair (the P4 wear overhaul, every open known defect, or
  one defect — exactly the cash commands' orders) and takes the loan in one step. **Cash
  needed = cost − incident claim − principal** = bill − principal (the insurer's claim and
  loan both pay the shop in the same step; a cash repair without a loan still needs the gross
  cost, the claim coming after). Ledger, in order: `repair_loan_disbursement +principal` (the
  insurer pays the shop), `insurance_claim +claim` for incident defects, then `repair −cost`,
  so the running balance never dips below the company's own share. The /fleet form shows the
  cash needed next to the quote.
- **Eligibility** (first failing rule wins; `repairLoanCheck`): owned (`not_owned`) → not
  assigned to a hired pilot and not flying (`aircraft_busy`) → an active policy
  (`not_insured`) → no open repair loan on that aircraft (`repair_loan_open`, one per aircraft)
  → then the repair's own refusals (`no_wear`, `no_defects`, `unknown_defect`,
  `already_queued`; the overhaul also needs the aircraft available) → a bill to finance
  (`no_repair_bill`) → term 6–24 (`bad_term`) → at least $500 (`bad_principal`) → at most the
  bill (`exceeds_bill`) → cash (`insufficient_cash`). Before any of these, the connector
  checks the arguments (`bad_args`) and refuses an aircraft on a loaded or flying mission
  (`aircraft_on_mission`).
- **No lien**: the loan names the aircraft (`collateral`) but `kind: "repair"` places no
  charge on it: the aircraft stays unencumbered for a bank loan (`financed` is about bank
  loans only).
- **Auto-debit** on the existing schedule (taken + 1 in-game month, then monthly): `interest`
  (operating) and `repair_loan_payment` (principal, capital) entries, event `loan.payment`.
- **Missed payment** (cash < payment), as for bank loans: late fee max($100, 5 % of the
  payment) booked even if cash goes negative, **−5 reputation**, the month's interest is
  capitalised, the term extends a month, `loan.missed` (with `kind: "repair"`). A successful
  payment resets the count. **Never a repossession and never the 12-month default flag**: the
  credit score is not halved.
- **Third consecutive miss**: the insurer **cancels the policy** and **calls the loan**: the
  whole capitalised balance is debited from cash at once (`repair_loan_payment`, cash may go
  negative, like a late fee), the loan closes with status **`called`**, event
  `insurance.cancelled {reason: "missed_payments", balanceMovedToCash}` and `loan.called
{loanId, kind: "repair", reason, balanceMovedToCash}`. The aircraft stays in
  the fleet, uninsured; a new policy can be bought later at the current premium.
- **Early payoff**: `loan.payoff {loanId}` (any time, no penalty), booked as
  `repair_loan_payment`; afterwards the policy can be cancelled.
- **Sale**: `fleet.sell` settles the repair loan from the proceeds (`repair_loan_payment`)
  after the bank loan; refused with `underwater` when 90 % of the value does not cover both.
- **Write-off** (insured, as every open repair loan is): the claim nets off the repair loan
  first (`repair_loan_payment`, loan `paid_off`), then the bank loan; a repair-loan remainder
  the claim cannot cover is debited from cash and the loan is `called` (`loan.called`, reason
  `aircraft_written_off`). The policy is not cancelled: the hull has left the fleet.
- **Bank repossession** of an aircraft with an open repair loan: the repair loan is called
  (balance from cash, `called`, `loan.called` with reason `aircraft_repossessed` and
  `balanceMovedToCash`).
- Repair loans count as **debt** (net worth, credit-score debt ratio, debt-to-income on
  /company). The **Debt-free** milestone needs every loan `paid_off`, so a called loan (like a
  defaulted one) never counts as repaid. Conversely, a write-off whose claim nets off the
  company's only loans leaves them `paid_off`, which reaches Debt-free: the same rule bank
  loans settled from a write-off claim already follow.

### Worked examples (exact cents, `repair-loans.test.ts`)

**Incident repair.** A $19,440 hard-landing gear repair at KMEM: claim 80 % × ($19,440 −
$2,000) = $13,952 → bill **$5,488**. Financed in full over 12 months: payment **$467.30**,
month 1 interest $18.29 / principal $449.01, the 12th payment $467.33, total interest
**$119.63**. `$5,488.01` is refused (`exceeds_bill`). Ledger: `repair_loan_disbursement
+5,488`, `insurance_claim +13,952`, `repair −19,440`: net cash **$0** for the repair today, so
it goes through with $10,000 in cash (balances 15,488 → 29,440 → 10,000) and even with $0.
Financing $3,000 of the bill instead leaves **$2,488** to pay from cash: $2,487.99 is refused
(`insufficient_cash`), $2,488.00 is enough. Amounts are judged in cents ($499.996 is $500.00).

**Overhaul.** A C208B at 19.5 % condition: overhaul $173,880 (no claim: wear is not an
incident) → bill $173,880. Financed $150,000 over 24 months (cash needed $23,880): payment
**$6,513.74**; month 1 interest **$500.00**, principal **$6,013.74**, balance
**$143,986.26**; month 24 pays $6,513.68; total interest **$6,329.70** — every debit equals an
integer-cent reference schedule computed independently in the test.

**Three misses** (the same $150,000 loan, cash $0 at every due date, reputation 50):

| Due date | Payment due | Late fee | Interest capitalised | Balance    | Reputation | Result                    |
| -------- | ----------- | -------- | -------------------- | ---------- | ---------- | ------------------------- |
| Month 1  | 6,513.74    | −325.69  | 500.00               | 150,500.00 | 45         | `loan.missed` (1)         |
| Month 2  | 6,513.74    | −325.69  | 501.67               | 151,001.67 | 40         | `loan.missed` (2)         |
| Month 3  | 6,513.74    | −325.69  | 503.34               | 151,505.01 | 35         | `loan.missed` (3), called |

At the third miss the ledger books `repair_loan_payment −151,505.01` ("balance moved to
cash"): the loan is `called` with balance 0, the policy is cancelled
(`insurance.cancelled`), the aircraft stays in the fleet (no `aircraft.repossessed`),
`defaultUntilGameMs` stays null. The loan's cash effect over the three months is −3 × 325.69 −
151,505.01 = **−$152,482.08** (plus the premiums billed on those month boundaries, as for any
insured aircraft); Σ ledger = cash − starting cash still holds to the cent, and later months
book nothing more for the loan.

### Storage, export and UI

No migration: repair loans are rows of the P4 `loans` table (`lender` = `insurer`,
`collateral_type/id` = the aircraft) with `kind: "repair"` and `orderId` in the row's JSON;
`status` may be `called`. Career export **version 5** carries them as optional loan fields
(absent = bank loan, so older v5 files import unchanged). A career that ever took one cannot
move to an older connector: its ledger has `repair_loan_disbursement` rows, which an older
connector refuses as invalid instead of misreading the loan as a repossessable bank loan.
`GET /api/loans` and the `loans` domain list them (`kind`, `orderId`, lender "Hull insurer");
fleet aircraft carry `insurance.repairLoan` (terms, `overhaulBill`, `allDefectsBill`, the open
loan). UI: **Finance with insurer** on /fleet (the selected aircraft: wear overhaul or every
open defect, amount ≤ bill, 6–24 months with a live quote, the reason when it is locked) and
the loans list on /company (repair loan, no collateral, the no-repossession miss rule, called
loans). In demo mode the panel is tagged DEMO with every control disabled; the demo company
takes no repair loan.

## Milestones

Reached once, persisted with the company-clock time and the wall clock (`milestones` table and
the company record), announced with `milestone.reached`, listed on `/company`:

| Milestone              | Reached when                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| First delivery         | a mission is delivered and paid                                                  |
| 100 flight hours       | the company's aircraft have flown 100 airborne hours (counted from P5 part 2 on) |
| First FBO              | an FBO is bought or built                                                        |
| Debt-free              | every loan ever taken is paid off                                                |
| Perfect landing streak | 5 deliveries in a row landed A or A+                                             |
| First restoration      | a used aircraft's last known defect is repaired                                  |
| Growing fleet          | 3 aircraft in the fleet at once                                                  |
| FBO network            | FBOs at 3 airports                                                               |

## Ledger categories (P5 part 2)

`fbo_income` (daily modelled traffic, AI bonuses), `fbo_upkeep` (modules + land lease),
`fbo_purchase` and `fbo_construction` (purchase, construction, module installs and upgrades:
**capital**, excluded from the operating P&L like aircraft purchases), `insurance`,
`insurance_claim`; insurer repair loans add `repair_loan_disbursement` and
`repair_loan_payment` (**capital**, like bank-loan principal; their interest and late fees use
`interest` and `late_fee`). The Company page shows a monthly P&L line per FBO (income, upkeep, net,
own-fleet savings).

## Storage, export, API (P5 part 2)

Migration 6 (idempotent, `IF NOT EXISTS` / `OR REPLACE`): `fbos(id, icao, status, built_at,
json)`, `fbo_modules(fbo_id, kind, level, json)`, `fbo_transactions(id, fbo_id, at, game_at,
kind, amount, source CHECK own|modelled|sim_ai, memo)`, `demand_events(id, icao, kind,
start_at, end_at, json)`, `demand_index(icao, activity)`, `insurance_policies(aircraft_id,
status, premium, json)`, `milestones(id, game_at, at)`, settings `economy.phase = 6`. Company
and fleet rows gain JSON fields with defaults; a P5-part-1 company starts the day clock from
its current in-game day (no retroactive events). Career export **version 4** adds `fbos`,
`fboTransactions` and `demandEvents` (company: activity, counters, milestones; fleet:
insurance, incidents); versions 1–3 import. API: `GET /api/fbos?fbo&limit`,
`/api/fbos/quote?icao=`, `/api/demand`.

## Demo (P5 part 2)

`buildDemoCompany` also insures the financed starter (day 20.6), buys the FBO at **KLIT** on
day 57 (fuel farm and ramp included), adds a hangar, upgrades the ramp to level 2 and prices
fuel at 104 % / handling at $85 on day 60, flies three legs through KLIT (own-arrival savings)
and records deliveries for demand activity; milestones carry the in-game date they were
reached. Everything is tagged DEMO with every action disabled.

---

# P6 — Hired pilots (optional, simulated)

Code: `packages/economy/src/hired-pilots.ts` (constants and pure rules) and the "Hired pilots"
section of `book.ts` (scheduling and booking), the connector's `core/economy/engine.ts`
(commands, served airports, the `mission.load` refusal) and protocol
`packages/protocol/src/pilots.ts`. Worked examples are unit tests in
`packages/economy/test/hired-pilots.test.ts` and `connector/test/hired-pilots.test.ts`.

A hired pilot flies **one owned aircraft** back and forth on a **fixed route** (origin →
destination → origin …) in in-game time, for a monthly wage, while you fly something else.

**Honesty.** This is a simulated economy model, not telemetry. A hired leg never produces a
flight frame, never touches the `flight`/`position`/`motion`/… domains, never writes a logbook
flight, never grades a landing, never changes reputation, deliveries, the landing streak,
demand activity or the 100-hour count (`company.flightHours`), so it can reach no milestone
about your own flying. Every pilot object carries `simulated: true`; the UI labels it **Hired
pilot (simulated)**. Domains still ride in frames tagged with the session's `source`
(`sim`/`replay`/`demo`) like every economy domain; that tag says which connector session
computed them, not that a simulator flew them.

## Clock and schedule

Legs run on the **company clock** (see "Company clock"): real time while the connector runs,
at most 60 s across a stop or a sleeping PC, so nothing accrues while the connector is off.
`CompanyBook.advance` processes every pilot's next departure and arrival in time order with
the loans, repairs and FBO hours.

```
airborne   = round(distance / cruise kt × 60 + 10) min
block      = airborne + 20 min                       (taxi out + in)
departure  = first time ≥ the previous arrival + 120 min turnaround inside 06:00–20:00
             (company-clock hour of day; outside the window the pilot waits for 06:00)
first leg  = the first duty-window time at or after the assignment
```

## Ratings and wages

| Rating    | Covers                                 | Wage / in-game month |
| --------- | -------------------------------------- | -------------------- |
| Turboprop | single-, twin- and regional-turboprops | $7,500               |
| Jet       | narrowbody and widebody jets           | $14,000              |

At hiring the wage for **the rest of the current in-game month** is paid, pro-rated by the time
left and rounded to the cent; then every pilot on the payroll is billed the full wage at each
month boundary for the coming month (`pilot_wage`, cash may go negative like lease fees).
Letting a pilot go refunds nothing and stops the wages. At most **10** pilots.

```
first wage = round(wage in cents × (next month boundary − now) / 30 days) / 100
```

Examples (turboprop, $7,500): hired at the start of a month → **$7,500**; on day 20 of 30 (10
days left) → 7,500 × 10 / 30 = **$2,500.00**, then $7,500 at the boundary; one minute before the
boundary → 7,500 × 60,000 / 2,592,000,000 = **$0.17**, then $7,500 a minute later (never twice
the full wage for one month).

## Assignment

`pilot.assign {pilotId, aircraftId, origin?, destination}` needs: a hired, unassigned pilot;
an **owned** aircraft (`not_owned` for leases) that is **available** (not in maintenance, not
flying, not on a loaded or flying mission, not with another pilot), holds no ferry permit,
matches the rating (`rating_mismatch`) and passes the **dispatch gate** (hidden defects surface
first, `aircraft_unairworthy` with every reason). The route starts where the aircraft is parked
(`aircraft_not_at_origin` otherwise). The destination must be an airport the company **serves**:
the base, fleet locations, own FBO airports, airports with recent demand activity (your
deliveries and departures), the job board airports and their jobs' destinations, and the ends of
existing pilot routes (`airport_not_served`). The route must suit the type both ways: 20 nm to
80 % of range (`route_too_short`, `out_of_range`), runway length and surface at both ends
(`runway_unsuitable`) and a payload limit of at least 50 kg (`payload_too_low`).

While assigned the aircraft's fleet status is **`hired`**: `mission.load` on it is refused
with **`aircraft_with_hired_pilot`** ("… is flown by hired pilot NAME on A–B (simulated):
unassign the pilot on the Fleet page to fly it yourself"), and every other action on it is
refused with `aircraft_busy`: selling, returning, repairs, annual inspections, deferrals,
ferry permits, buying or cancelling hull insurance, and pledging it as loan collateral.
A repossession (missed loan payments on an aircraft pledged before it was assigned) stops the
route at once with `pilot.route_stopped` (`aircraft_repossessed`).
`pilot.unassign` makes it available where it is; a leg in progress is **cancelled** (the
aircraft stays at the leg's departure airport and nothing is booked for that leg).

## Money per leg (booked when the leg arrives)

```
load      = round(share × floor(payload limit × (1 − major-defect payload penalty)))   kg
share     = uniform 0.50–0.90, mulberry32(FNV-1a(company seed, "pilot-leg", pilot id, leg n))
board     = computePayout(cargo, load kg, distance, 1 unit, reputation, estimate).total
income    = 50 % × board                                   (hired_income, cents)
fuel      = round(cruise burn kg/h × block h) × (1 + defect fuel penalty) × the destination's
            fuel price (demand events included)           (fuel, refType "pilot")
fee       = landing fee at the destination                 (landing_fee, refType "pilot")
wear      = 0.5 × airborne h   (no G or overspeed: there is no touchdown to measure)
```

The 50 % share keeps hired flying **below** what you earn flying the same job yourself (you get
100 % plus landing and weather bonuses). Wear is spread over the systems and rolls for new
defects exactly like your own flights (thresholds 75/50/30 %, seeded per aircraft, cycle and
pilot); hours and cycles count on the airframe. The aircraft event is `pilot_leg` (never
`flight`). Hired legs pay the normal fuel price and landing fee also at your own FBO (FBO
benefits are for your own arrivals) and add no demand activity. The demand payout factor is
not applied to hired income.

**Grounding.** At every departure the gate runs again (hidden defects surface); after every
leg, a defect that makes the aircraft unairworthy (a grounding defect, an undeferred minor, a
system under 20 %, an overdue annual) **stops the route at once**: the aircraft becomes
`available` where it landed, the pilot stays hired with `stopped {code, message}`, and the
event `pilot.route_stopped` (`simulated: true`) is sent with `aircraft.grounded` for the defect.
Repair it (or defer the minor) and assign again.

## Worked examples (`packages/economy/test/hired-pilots.test.ts`)

C208B **KMEM → KATL**, 287.7 nm: airborne 287.7 / 170 × 60 + 10 = **112 min**, block
**132 min**, fuel 170 × 2.2 = **374 kg**; payload limit 944 kg. At the average share 0.7: **661
kg**, board **$5,606**, hired income **$2,803** (the route preview).

Seed 4242, starter at KMEM, assigned at 00:00 on day 0: departures 06:00, 10:12, 14:24 and
18:36, arrivals 08:12, 12:24, 16:36, 20:48.

| Leg       | Load   | Income    | Fuel                      | Fee  |
| --------- | ------ | --------- | ------------------------- | ---- |
| KMEM→KATL | 839 kg | $3,557.50 | 374 kg × $1.915 = $716.21 | $300 |
| KATL→KMEM | 751 kg | $3,184.50 | 374 kg × $1.948 = $728.55 | $300 |
| KMEM→KATL | 485 kg | $2,056.50 | $716.21                   | $300 |
| KATL→KMEM | 710 kg | $3,010.50 | $728.55                   | $300 |

Day 1 P&L (month 1 row): income **$11,809**, wage $7,500 (paid at hiring), fuel **$2,889.52**,
fees **$1,200**, net **$219.48**; cash 250,000 → **$250,219.48**; wear 4 × 0.93 = **3.72**
points (repair value 8 % × $2.7M × 3.72 % = **$8,035.20**, not cash: repairs are ordered as
usual). Airframe +7.48 h, 4 cycles; `company.flightHours` stays **0**.

Read honestly: a C208B leg nets about $1,900 in cash before wear and about breaks even once its
wear is repaired, so a hired pilot is modest income that slowly converts airframe condition into
cash, not a money machine; wear and its defect rolls end the route within weeks of in-game time
(a 40-day run in the tests stops on its own).

## Ledger and P&L

Categories `pilot_wage` and `hired_income` (operating, in the monthly company P&L); fuel and
landing fees use the existing `fuel` and `landing_fee` categories with `refType "pilot"` and
`refId` the pilot id. Every amount goes through `CompanyBook.post`, so **Σ ledger = cash −
starting cash** to the cent (tests after a day, a month rollover and a 40-day run). Each pilot
keeps a monthly P&L (last 12 months): income, wages, fuel, fees, `net = income − wages − fuel −
fees` summed in integer cents, legs, wear points and their repair value (not cash), plus the
last 10 legs. The domain's monthly totals sum this month's rows over **every** pilot record, so
a pilot let go this month still counts (the wage was paid), and that pilot stays listed with
status `fired` until the month ends.

## Storage, export, API

Migration **9** (idempotent): `hired_pilots(id, status CHECK hired|fired, aircraft_id, json)`;
the company row gains `pilotCounter` (JSON, default 0) and fleet rows may carry the status
`hired` (no column change). Career export: `pilots` is an **optional** field of version 5 (no
format bump; files without it import with no pilots). A career that ever hired a pilot cannot
move to an older connector: its ledger has `pilot_wage`/`hired_income` rows (and an assigned
aircraft the status `hired`), which an older connector does not know, so it refuses the file as
invalid instead of misreading it, assigned pilots or not. Loading repairs what an import cannot
be trusted with: an aircraft marked `hired` without a pilot loads `available`; a pilot assigned
to an aircraft not marked `hired`, or a second pilot on an aircraft another pilot already flies
(the first in hiring order keeps it), is unassigned with `stopped.code` `assignment_invalid`.
API:
`GET /api/pilots` (the `pilots` domain). Commands: `pilot.hire {rating}`,
`pilot.fire {pilotId}`, `pilot.assign {pilotId, aircraftId, origin?, destination}`,
`pilot.unassign {pilotId}` (zod, strict; same token and Origin rules as every command).

## Demo

`buildDemoCompany` hires a turboprop pilot on day **74** (day 15 of month 3: 16 days left, first
wage $4,000) and assigns the starter C208B to
**KMEM ⇄ KBNA** (173.6 nm); by day 77.6 it has flown 14 legs. Shown on /fleet → Hired pilots,
tagged DEMO and "Hired pilot (simulated)", with every action disabled.
