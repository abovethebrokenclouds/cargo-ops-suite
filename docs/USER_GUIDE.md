# Cargo Ops — Player guide

Cargo Ops runs a cargo airline alongside Microsoft Flight Simulator 2020/2024: you take
contracts, fly them in the sim, get paid, and grow a company with aircraft, loans and FBOs.
Everything runs on your PC; there are no accounts. Setup details: `docs/SETUP_WINDOWS.md`.

> The real simulator connection has not been tested yet (it was built and tested with recorded
> replays). Your first sessions are the test — `docs/VERIFICATION.md` has a first-run checklist.

## 1. Start

1. Double-click `scripts\start-cargo-ops.cmd` (first run installs and builds, a few minutes).
   Your browser opens <http://127.0.0.1:4311>. Keep the window open while you play.
2. Optional: install it as an app (Edge/Chrome "Install Cargo Ops", setup guide §11) and create
   shortcuts or start it with Windows (`scripts\create-shortcut.ps1`, §12).

## 2. Connect

Start MSFS. The chip at the top right tells you where the numbers come from:

- `CONNECTING` / `CONNECTOR OFFLINE` — the page cannot reach the connector (is its window open?).
- `SIM OFFLINE` — the connector runs, MSFS is not connected yet; it retries on its own.
- `LIVE · MSFS 2024 · SunRise` (or `2020 · KittyHawk`) — live data from your simulator.
- `REPLAY` — the connector plays a recording (`--sim fake`), stored in a separate demo database.
- `DEMO DATA` — not served by the connector (preview/dev server): a built-in recording, every
  action disabled.

Values are tagged `SIM`, `REPLAY` or `DEMO`; a dash means "no data", never a made-up number.

## 3. Take a job

1. Park the aircraft at an airport in the sim and open **Jobs** (`g` `j`).
2. Enter the **Board airport** (and optionally **Jobs to**), press refresh. Contracts are generated
   for your selected fleet aircraft: runway, range and payload are checked, the payout estimate is
   itemised. Cargo kinds: general, fragile (G limit), express (deadline), medical, hazmat, bush.
3. **Accept** one or more jobs, tick them and **Load** them into a mission. Loading is refused
   with a reason when the aircraft is not airworthy, not at the origin, busy, or too heavy.
4. With SimBrief import on (Settings), the job board shows your planned route and a button for
   contracts on it.
5. **Load the cargo in the sim too.** The mission strip shows a **payload check**: the sim's
   payload stations minus the crew (the first Pilot/Co-pilot/Captain seat plus any Crew seats,
   otherwise nothing; change it in
   **Payload check crew allowance** on Jobs) against the cargo weight, with a 10 % (at least
   25 kg) tolerance. If the sim payload is clearly below the cargo when you depart, the
   mission still flies but pays **no bonuses**. Above max gross weight the start is refused.
   An aircraft that reports no payload stations shows "Payload unknown" and is never
   penalised.

## 4. Fly and deliver

1. In the sim: on the ground at the origin (within 3 nm), parking brake **set**, then start.
   Block-out starts the mission; **Live Flight** (`g` `f`) shows altitude, speeds, fuel,
   endurance vs ETE, phase, payload and, after touchdown, the landing grade. **Weather en
   route** shows the origin and destination METAR: a VFR / MVFR / IFR / LIFR chip, wind,
   visibility, ceiling, how old the observation is and the raw text on request. On the job board
   each contract has a **Weather** button with the same view. For simulation only: never use it
   for real-world flight planning.
2. Fly it. The **Map** (`g` `m`) follows the aircraft (`f` toggles follow), with route, trail,
   airports, your FBOs and demand events.
3. Land, taxi in, **park with engines off and the brake set**. The leg is verified (≥ 90 % of
   the distance flown, arrival within 3 nm, no teleport/slew, sim rate ≤ 8×) and the payout is
   booked with its breakdown: landing grade multiplier, lateness, fuel at the landing airport's
   price, landing fee. Pausing stops the clock; above 1× sim rate there are no bonuses.
4. A crash fails the mission (reputation −20, repairs). Every flight lands in the **Logbook**
   (`g` `l`) with track, grade and payout; export CSV, GPX (one flight) or the whole career (JSON).

### Transit cargo (more than one leg)

Some contracts go further than one leg: jobs tagged **Needs a stop** are beyond your aircraft's
direct range, and any job can be routed through another airport (a hub, a longer runway, a
place where you switch aircraft).

1. Tick the jobs, type the intermediate airport in **Leg to** and **Load**. The mission strip
   says how many jobs go beyond it. The leg must bring the cargo closer to where it is going,
   and range, runway, payload, fuel and weight are checked for this leg as usual.
2. Fly the leg. On arrival the cargo is unloaded and **stored in transit** there: the job moves to
   **Transit cargo** on Jobs with its airport, final destination and deadline, and the map shows a
   pin at that airport (hover it for the deadlines). Nothing is paid yet.
3. Later, with an aircraft at that airport, tick the stored job (alone or with others from the
   same airport) and load the next leg — to its destination, or to another stop.
4. The full payout comes on the **final delivery**, with the landing grade of the last leg. The
   time limit covers **the whole trip**: every leg's block time plus the time the cargo waits on
   the ground (company clock). If you own an FBO with a **cargo terminal** there, the first 4 / 8 /
   12 hours (level 1 / 2 / 3) of waiting do not count. A crash on any leg loses the cargo;
   **Abandon** gives it up where it is (no payout, −3 reputation).

## 5. Company, fleet, loans, used market, FBOs

- **Company** (`g` `c`): cash, reputation 0–100 (tiers unlock aircraft, job kinds and loans),
  credit score, the ledger (every dollar), monthly P&L, milestones. The company clock runs in
  in-game time while the connector runs; monthly items (loan payments, lease fees, FBO upkeep)
  are debited at month boundaries.
- **Fleet** (`g` `e`): buy or dry/wet-lease new aircraft, sell, repair wear, pick the active
  aircraft (or let the sim's aircraft title auto-match). Each airframe has systems with defects;
  a grounding defect, an expired deferral, a system under 20 % or an overdue annual inspection
  blocks dispatch until fixed. Minor defects can be deferred. A **ferry permit** allows one
  no-revenue flight to the nearest maintenance airport. Optional hull **insurance** per aircraft.
- **Used market**: cheaper aircraft with known and hidden defects. A pre-purchase **inspection**
  (fee) reveals hidden ones; without it a grounding defect may surface on the first dispatch.
- **Loans**: three fictional lenders; the calculator shows the monthly payment; the aircraft or
  FBO is collateral. Missed payments cost a late fee and reputation; three in a row means
  repossession. Early payoff is free.
- **FBOs** (`g` `b`): buy or build one at an airport, add and upgrade modules (fuel farm,
  hangar, maintenance shop, cargo terminal, ramp), set fuel and handling prices. Income comes from
  your own arrivals (fuel at cost, no landing fee), a modelled traffic stream, and — live only —
  a bonus for AI aircraft the sim shows landing there.

Formulas and worked examples: `docs/ECONOMY.md`.

## 6. Keyboard shortcuts

Press `?` for the list. `g` then a letter: `o` Ops, `f` Flight, `m` Map, `j` Jobs, `l` Logbook,
`c` Company, `b` FBOs, `e` Fleet, `s` Settings, `d` Diagnostics. On the map, `f` toggles follow.
Shortcuts are ignored while you type in a field.

## 7. Settings, backups and your data

- **Units** (this browser): lb/kg and ft/m for Live Flight and map readouts. Cargo and economy
  figures are always kg and USD; speeds are knots.
- **Connector**: address and a masked token (reset with `--reset-token`, setup guide §6).
- **Basemap**: local extract → online OpenFreeMap (switch off to stay offline) → outline.
- **Weather** (this browser): **Online weather** lets the connector fetch origin and destination
  METARs from aviationweather.gov (NOAA, no account) for Live Flight and the job board; switch it
  off and no weather request leaves your PC. Replays and the demo show **SAMPLE** METARs, which
  are examples, never real weather.
- **Data**: **Back up now**, the backup list (a daily backup is automatic, newest 14 kept),
  career export/import (import replaces the career; refused during a flight). Restoring a backup
  is manual with the connector stopped — steps in the page and in setup guide §6.
- **SimBrief** (optional, off): your own username or pilot ID; Import fetches your latest OFP
  from simbrief.com.

Animations respect Windows' "Show animations" / `prefers-reduced-motion` setting.
