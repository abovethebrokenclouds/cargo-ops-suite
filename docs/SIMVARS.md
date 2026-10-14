# SimConnect names audit (SimVars, system events, system states)

Audit of every name the connector asks SimConnect for, against the Microsoft Flight
Simulator SDK documentation. The checked-in allow-list is
`connector/src/sim/simvar-catalog.ts`; `connector/test/simvar-catalog.test.ts` fails if
`simvars.ts`, the AI traffic definition (`ai-traffic.ts`) or `simconnect-source.ts`
requests a name that is not in it, a unit that is not dimensionally compatible with the
documented one, a string SimVar with a numeric datum type (or the reverse), or gets the
`:index` wrong. It also fails if a request call passes its name as a string literal instead
of going through those tables.

**Accessed:** 2026-10-13/14. **Nothing here has been checked against a running simulator**;
the PC rows PC-07, PC-12, PC-20, PC-53 and PC-55 in `docs/VERIFICATION.md` still decide that.

## How the documentation was reached (and what was not)

The SDK site could not be opened directly from the build container:

| Route tried                                                                          | Result                                                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `curl` through the container's HTTPS proxy, `docs.flightsimulator.com` (2020 + 2024) | `CONNECT tunnel failed, response 403`: the egress policy denies the host; not retried or routed around      |
| Web fetch tool, `docs.flightsimulator.com/html/.../Miscellaneous_Variables.htm`      | `getaddrinfo ENOTFOUND docs.flightsimulator.com`                                                            |
| Web fetch tool, `devsupport.flightsimulator.com` (SDK forum)                         | `getaddrinfo ENOTFOUND`                                                                                     |
| Web search restricted to the SDK pages                                               | worked: search-engine extracts of the 2020 and 2024 SDK pages (used for the notes marked **[search]**)      |
| Web fetch of `github.com/Pomax/msfs-simconnect-api-wrapper` (MIT) `simvars/*.js`     | worked: a SimVar table transcribed from the 2020 SDK pages, each file citing its SDK page (marked **[tx]**) |

So every row below is backed by a secondary copy of the SDK text, not by reading the SDK page
itself. Two caveats about the transcription **[tx]**: it collapses compound units (it writes
`Feet` for `VERTICAL SPEED`, which the SDK lists in feet per second), so it is used for
**names, indexing, string-ness and the doc page**, while the documented units come from the
SDK unit names as quoted in search extracts where available. Where the two sources do not
settle something, the row says so. Settable flags are informational only (the connector
never writes a SimVar). Neither source carries the SDK's settable column, so it is "?"
everywhere except where the documented description itself says the variable can be set.

Doc pages (MSFS 2020 SDK; MSFS 2024 keeps the same names, its index is
[Simulation Variables (2024)](https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Simulation_Variables.htm)):

- **Misc** = [Aircraft Misc. Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm) (2024: [Aircraft Misc. Variables](https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm))
- **FM** = [Aircraft Flight Model Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm)
- **Fuel** = [Aircraft Fuel Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Fuel_Variables.htm)
- **Eng** = [Aircraft Engine Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Engine_Variables.htm)
- **Sys** = [Aircraft System Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_System_Variables.htm)
- **Brk** = [Aircraft Brake/Landing Gear Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Brake_Landing_Gear_Variables.htm)
- **Nav** = [Aircraft Radio Navigation Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_RadioNavigation_Variables.htm)
- **MiscVars** = [Miscellaneous Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Miscellaneous_Variables.htm) (2024: [Miscellaneous Variables](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simvars/miscellaneous-variables/))
- **Env** = [Environment Variables](https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/Environment_Variables.htm)
- Units: [Simulation Variable Units](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Simulation_Variable_Units.htm)

## SimVars

"Our unit" is the unit string we pass to `addToDataDefinition`; SimConnect converts from the
documented unit when both are the same dimension (radians → degrees, ft/s → ft/min). Strings
are requested with a null unit and a fixed-length string datum type.

| SimVar                          | Def.     | Our unit / type       | Documented unit | Settable | Index        | 2020 | 2024 | Doc      | Notes                                                                                                                                                                                                                                     |
| ------------------------------- | -------- | --------------------- | --------------- | -------- | ------------ | ---- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NUMBER OF ENGINES               | counts   | number / f64          | Number          | ?        | —            | ✓    | ✓    | Eng      | SDK: 0 to 4; we clamp to 4                                                                                                                                                                                                                |
| PAYLOAD STATION COUNT           | counts   | number / f64          | Number          | ?        | —            | ✓    | ✓    | Sys      | we clamp to 20                                                                                                                                                                                                                            |
| TITLE                           | slow     | — / STRING256         | String          | ?        | —            | ✓    | ✓    | Misc     | **[tx]** String128; 256 is a superset. Kept over `ATC MODEL`, which is commonly reported to return a localisation token (`TT:ATCCOM.AC_MODEL…`) rather than a display name; what 2024 modular aircraft and liveries put in TITLE is PC-26 |
| ATC ID                          | slow, AI | — / STRING64          | String          | ?        | —            | ✓    | ✓    | Nav      | **[search]** 2024 bug report: briefly an auto-generated registration after a livery change                                                                                                                                                |
| FUEL TOTAL QUANTITY             | slow     | gallons / f64         | Gallons         | ?        | —            | ✓    | ✓    | Fuel     | documented in both SDKs; plan §14.2: may not match some 2024 aircraft, values need PC-09                                                                                                                                                  |
| FUEL TOTAL QUANTITY WEIGHT      | slow     | pounds / f64          | Pounds          | ?        | —            | ✓    | ✓    | Fuel     | same caveat (plan §14.2)                                                                                                                                                                                                                  |
| ENG FUEL FLOW PPH               | slow     | pounds per hour / f64 | Pounds per hour | ?        | `:1`..`:n` ✓ | ✓    | ✓    | Eng      | name and unit documented. `ENG FUEL FLOW GPH:n` (Gallons per hour) is catalogued as the alternative but not requested                                                                                                                     |
| TOTAL WEIGHT                    | slow     | pounds / f64          | Pounds          | ?        | —            | ✓    | ✓    | FM       |                                                                                                                                                                                                                                           |
| EMPTY WEIGHT                    | slow     | pounds / f64          | Pounds          | ?        | —            | ✓    | ✓    | FM       |                                                                                                                                                                                                                                           |
| MAX GROSS WEIGHT                | slow     | pounds / f64          | Pounds          | ?        | —            | ✓    | ✓    | FM       |                                                                                                                                                                                                                                           |
| PAYLOAD STATION WEIGHT          | slow     | pounds / f64          | Pounds          | ?        | `:1`..`:n` ✓ | ✓    | ✓    | Sys      | the old "community-verified unit" doubt is settled by the SDK table: Pounds                                                                                                                                                               |
| PAYLOAD STATION NAME            | slow     | — / STRING64          | String          | ?        | `:1`..`:n` ✓ | ✓    | ✓    | Sys      | **[tx]** String32; length is not documented, 64 is a superset                                                                                                                                                                             |
| GENERAL ENG COMBUSTION          | slow     | bool / f64            | Bool            | yes      | `:1`..`:n` ✓ | ✓    | ✓    | Eng      |                                                                                                                                                                                                                                           |
| BRAKE PARKING POSITION          | slow     | bool / f64            | Bool            | ?        | —            | ✓    | ✓    | Brk      | FSX-era SDKs documented a 0..32k position; `bool` reads non-zero as true either way                                                                                                                                                       |
| SIMULATION RATE                 | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Env      | name confirmed in both sources; change it with the `SIM_RATE_*` key events, not by setting it                                                                                                                                             |
| ZULU TIME                       | slow     | seconds / f64         | Seconds         | ?        | —            | ✓    | ✓    | Env      | seconds since midnight UTC                                                                                                                                                                                                                |
| ZULU DAY OF MONTH               | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Env      |                                                                                                                                                                                                                                           |
| ZULU MONTH OF YEAR              | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Env      |                                                                                                                                                                                                                                           |
| ZULU YEAR                       | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Env      |                                                                                                                                                                                                                                           |
| PLANE LATITUDE                  | fast, AI | degrees / f64         | Radians         | ?        | —            | ✓    | ✓    | Misc     | converted                                                                                                                                                                                                                                 |
| PLANE LONGITUDE                 | fast, AI | degrees / f64         | Radians         | ?        | —            | ✓    | ✓    | Misc     | converted                                                                                                                                                                                                                                 |
| INDICATED ALTITUDE              | fast     | feet / f64            | Feet            | ?        | —            | ✓    | ✓    | Sys      |                                                                                                                                                                                                                                           |
| PLANE ALT ABOVE GROUND          | fast     | feet / f64            | Feet            | ?        | —            | ✓    | ✓    | Misc     | `PLANE ALT ABOVE GROUND MINUS CG` also exists (gear-on-ground ≈ 0); not needed, on-ground comes from SIM ON GROUND                                                                                                                        |
| AIRSPEED INDICATED              | fast     | knots / f64           | Knots           | ?        | —            | ✓    | ✓    | Misc     |                                                                                                                                                                                                                                           |
| AIRSPEED TRUE                   | fast     | knots / f64           | Knots           | ?        | —            | ✓    | ✓    | Misc     |                                                                                                                                                                                                                                           |
| GROUND VELOCITY                 | fast, AI | knots / f64           | Knots           | ?        | —            | ✓    | ✓    | Misc     |                                                                                                                                                                                                                                           |
| PLANE HEADING DEGREES MAGNETIC  | fast     | degrees / f64         | Radians         | ?        | —            | ✓    | ✓    | Misc     | the name says degrees, the SDK unit is radians: requesting `degrees` converts                                                                                                                                                             |
| PLANE HEADING DEGREES TRUE      | fast     | degrees / f64         | Radians         | ?        | —            | ✓    | ✓    | Misc     | same                                                                                                                                                                                                                                      |
| VERTICAL SPEED                  | fast     | feet per minute / f64 | Feet per second | ?        | —            | ✓    | ✓    | Misc     | converted to fpm                                                                                                                                                                                                                          |
| G FORCE                         | fast     | GForce / f64          | GForce          | ?        | —            | ✓    | ✓    | FM       |                                                                                                                                                                                                                                           |
| SIM ON GROUND                   | fast, AI | bool / f64            | Bool            | ?        | —            | ✓    | ✓    | MiscVars | the only documented on-ground SimVar for the aircraft as a whole; **[search]** the 2024 page notes it is also available for far multiplayer aircraft                                                                                      |
| PLANE TOUCHDOWN NORMAL VELOCITY | fast     | feet per second / f64 | Feet per second | ?        | —            | ✓    | ✓    | Misc     | **[search]** units feet per second; **sign convention not documented**. Mapping ×60 → fpm; the landing analyser uses `-abs()`, so either sign grades the same                                                                             |
| PLANE TOUCHDOWN BANK DEGREES    | fast     | degrees / f64         | Degrees         | ?        | —            | ✓    | ✓    | Misc     | sign convention not documented; reported as the sim gives it                                                                                                                                                                              |
| PLANE TOUCHDOWN PITCH DEGREES   | fast     | degrees / f64         | Degrees         | ?        | —            | ✓    | ✓    | Misc     | sign convention not documented; reported as the sim gives it (PC-20 should note whether nose-up is negative)                                                                                                                              |
| GPS IS ACTIVE FLIGHT PLAN       | slow     | bool / f64            | Bool            | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** "Flight plan mode active". Plan §14.1: the GPS SimVars are deprecated in 2024 and may not reflect EFB plans. Missing (rejected) or false → no GPS plan                                                                          |
| GPS FLIGHT PLAN WP COUNT        | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** "Number of waypoints". 0 → no GPS plan                                                                                                                                                                                          |
| GPS FLIGHT PLAN WP INDEX        | slow     | number / f64          | Number          | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** "Index of waypoint". Read as the 0-based index of the active (next) waypoint: the numbering is **not documented**; PC-55 checks that the last leg reads `count − 1`                                                             |
| GPS WP NEXT ID                  | slow     | — / STRING64          | String          | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** String32; 64 is a superset. Read but empty → no GPS plan (MSFS 2024 can leave the plan flag set with empty values for EFB plans). On the last leg it is the destination ident                                                   |
| GPS WP NEXT LAT                 | slow     | degrees / f64         | Degrees         | ?        | —            | ✓    | ✓    | Nav      | **[tx2]**; 0/0 is treated as "not reported"                                                                                                                                                                                               |
| GPS WP NEXT LON                 | slow     | degrees / f64         | Degrees         | ?        | —            | ✓    | ✓    | Nav      | **[tx2]**; same                                                                                                                                                                                                                           |
| GPS WP DISTANCE                 | slow     | nautical miles / f64  | Meters          | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** documented in meters; requested in nautical miles (`nautical miles` is a SimConnect length unit, so it converts). On the last leg it is the remaining distance                                                                  |
| GPS WP ETE                      | slow     | seconds / f64         | Seconds         | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** ETE to the next waypoint; 0 → not reported                                                                                                                                                                                      |
| GPS ETE                         | slow     | seconds / f64         | Seconds         | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** "Estimated time en route to destination"; 0 → not reported                                                                                                                                                                      |
| GPS APPROACH AIRPORT ID         | slow     | — / STRING64          | String          | ?        | —            | ✓    | ✓    | Nav      | **[tx2]** String32, "ID of airport" of the loaded approach; used as the GPS destination only when non-empty and the active waypoint is not the last one                                                                                   |

**[tx2]** (2026-10-14, GPS rows): the SDK pages were still unreachable from the container
(`docs.flightsimulator.com` → `CONNECT tunnel failed, response 403`; the GitHub API for the
transcription repository is not enabled for the session). The same transcription **[tx]**
was read from its npm package instead: `msfs-simconnect-api-wrapper` 4.7.0, tarball from
`registry.npmjs.org`, file `simvars/aircraft-radio-navigation-variables.js`, which cites the
2020 SDK page [Aircraft Radio Navigation Variables](https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_RadioNavigation_Variables.htm).
Only names, documented units, string-ness and descriptions were taken from it; no code was
copied and the package is not a dependency (the `LICENSE.md` in that tarball limits use of its
code to non-commercial projects, so nothing of it is shipped or vendored). Its data-type column also flags several of these
as settable; the connector never writes them. There is no SimVar that names the flight plan's
destination outright, so the GPS plan has a destination ident only on the last leg or with an
approach loaded; otherwise `/flight` shows the GPS ETE and the next waypoint without one.

**Destination fallback (no GPS plan).** When the GPS plan is inactive, empty or rejected, the
connector uses a manual destination (picked on `/flight`, `plan.destination`, for the current
flight only) or the loaded mission's destination, and computes distance (great circle from
`PLANE LATITUDE/LONGITUDE` to the OurAirports reference point) and ETE (distance /
`GROUND VELOCITY`, only at 30 kt or more). Those are labelled Manual or Mission, never GPS.

### Removed

| SimVar       | Why                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IS ON GROUND | Not a row in the 2020 or the 2024 SimVar tables in either source (only `SIM ON GROUND`, `GEAR IS ON GROUND:n` and `CONTACT POINT IS ON GROUND:n` exist). Search extracts of the `SIM SHOULD SET ON GROUND` note mention "IS ON GROUND" in prose, which is where the plan picked it up, but without a table entry it is a likely "SimConnect rejected" on every connect. On-ground now reads `SIM ON GROUND` only. |

## System events (`SubscribeToSystemEvent`)

Doc: [SimConnect_SubscribeToSystemEvent](https://docs.flightsimulator.com/html/Programming_Tools/SimConnect/API_Reference/Events_And_Data/SimConnect_SubscribeToSystemEvent.htm)
(2024: [simconnect_subscribetosystemevent](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/api-reference/general/simconnect_subscribetosystemevent/)).
Event names are not case-sensitive (**[search]**, from that page).

| Event          | Payload we read                 | 2020 | 2024 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------- | ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause          | `dwData` 1 = paused             | ✓    | ✓    | kept alongside Pause_EX1, which distinguishes the pause kinds                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pause_EX1      | `dwData` flags                  | ✓    | ✓    | **Fixed:** any non-zero value is now a pause. The SDK header defines PAUSE 1, PAUSE_WITH_SOUND 2 (legacy), ACTIVE_PAUSE 4, SIM_PAUSE 8 (esc menu); the old mask `0b111` read 8 as running. These flag values could not be re-read from the SDK page in this audit; treating any non-zero as paused does not depend on them. Forum reports (2020): with the keyboard pause key active-pause values arrived reversed, and some builds sent 0 for the esc pause; PC-11 checks it |
| SimStart       | —                               | ✓    | ✓    | user in control again: ends the SimStop pause, re-requests the "Sim" state, re-reads engine/station counts (see "Effective pause")                                                                                                                                                                                                                                                                                                                                            |
| SimStop        | —                               | ✓    | ✓    | back to the main menu: counts as a pause (flight clock frozen), not a disconnect (see "Effective pause")                                                                                                                                                                                                                                                                                                                                                                      |
| FlightLoaded   | file name (`RecvEventFilename`) | ✓    | ✓    | **[search]** also fires when a flight ends (a default flight loads)                                                                                                                                                                                                                                                                                                                                                                                                           |
| AircraftLoaded | file name (`RecvEventFilename`) | ✓    | ✓    | **[search]** fires when the aircraft flight dynamics file changes                                                                                                                                                                                                                                                                                                                                                                                                             |
| Crashed        | —                               | ✓    | ✓    | **[search]** user aircraft crash                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CrashReset     | —                               | ✓    | ✓    | **[search]** after the crash cut-scene                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1sec           | —                               | ✓    | ✓    | **[search]**; subscribed, currently unused                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## System state (`RequestSystemState`)

Doc: [SimConnect_RequestSystemState](https://docs.flightsimulator.com/html/Programming_Tools/SimConnect/API_Reference/General/SimConnect_RequestSystemState.htm)
(2024: [simconnect_requestsystemstate](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/api-reference/general/simconnect_requestsystemstate/)).

| State | Read as                                           | Notes                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sim   | `dataInteger` 1 = user in control of the aircraft | **[search]** 0 = the user is navigating the UI. Requested on connect and again after every SimStart; 0 counts as a pause (see "Effective pause"). Documented states: AircraftLoaded, DialogMode, FlightLoaded, FlightPlan, Sim |

## Effective pause (plan §14.4)

Pause / Pause_EX1 misreport in some builds (forum reports, PC-11), so the connector does not
trust them alone (`connector/src/sim/pause-state.ts`, tests in
`connector/test/sim-running-pause.test.ts` and the emulator suite):

- **effective paused = pause flag OR sim not running.** The pause flag is the latest Pause or
  Pause_EX1 report; "sim running" comes from SimStart / SimStop and the `"Sim"` system state
  (requested on connect and after every SimStart to resync). Before the first answer the run
  state is unknown and counts as running: no pause is invented without a report.
- The `sim` domain's `paused` and the `sim.paused` event (`event`: `Pause`, `Pause_EX1`,
  `SimStop`, `SimStart`, `SimState` or `stuck_pause`) carry the effective value; they change
  only when it changes.
- **SimStop is a pause, not a disconnect.** The link stays up, nothing is cleared, the running
  flight keeps its id and phase; its sim clock (block time, the deadline clock, the
  economy's simulator minutes) stops at SimStop and resumes at SimStart. The interval that ends
  a pause is never counted, so the menu time is not added by the first frame after SimStart.
  No frames are made up during a stop; frames the simulator does send keep the `sim` source tag.
- **Flight plan during a stop.** The `plan` domain is published in the menu too: the last
  resolved plan (GPS, manual or mission) stays as it was, because the flight is paused, not
  ended, and the destination is still the one the pilot will resume towards. Nothing is
  recomputed or invented while no frames arrive; a frame the simulator does send in the menu
  is resolved as usual (a GPS plan it reports as inactive falls back to the manual or mission
  destination, never a kept GPS plan), and `plan.destination` still works. Only a real
  disconnect clears the plan (`connector/src/core/plan.ts`; emulator test "SimStop (main
  menu) is a pause").
- **Stuck pause rule.** A pause flag that never clears is overridden only when all of these
  hold: a SimStart arrived after the latest pause report; the sim is running; and consecutive
  fresh position frames have shown the aircraft really moving (position changed from the
  previous frame and ground speed ≥ 5 kt) for at least **10 s**. One frame without movement
  restarts the count. A warning is logged and `sim.paused` reports `event: "stuck_pause"`. A
  parked aircraft therefore stays paused until it moves, and any later Pause / Pause_EX1 report
  replaces the flag (a pause reported after the SimStart is always honoured).
- A real link loss is different: see the flight core header (`connector/src/core/flight-core.ts`)
  for the disconnect rules (flight suspended, offline time not counted, commands refused).

## What still needs the PC

- **PC-53**: SimStop / SimStart and the `"Sim"` state on the real sim: back to the main menu
  mid-flight pauses the flight clock and resumes it after the next SimStart; record whether
  MSFS sends user-aircraft frames in the menu and whether Pause_EX1 ever stays set (see
  "Effective pause").
- **PC-07**: no `SimConnect rejected` lines at all on MSFS 2020 and 2024 (the audit removes
  the one name that was not in the SDK tables; everything else is a documented name).
- **PC-12**: values, not names: `SIMULATION RATE` follows rate changes, payload station
  weights/names match the payload screen, `ENG FUEL FLOW PPH` and the fuel totals match on
  a 2024 aircraft that uses the new fuel system, `SIM ON GROUND` flips on touchdown/lift-off.
- **PC-20**: touchdown values are latched and fresh after each landing; record the sign of
  `PLANE TOUCHDOWN NORMAL VELOCITY` (descending) and of `PLANE TOUCHDOWN PITCH DEGREES`
  (nose-up) and update the notes above.
- **PC-55**: GPS flight plan on MSFS 2024: whether a plan made in the EFB (and one entered in
  the aircraft's GPS) sets `GPS IS ACTIVE FLIGHT PLAN` with real values, whether
  `GPS FLIGHT PLAN WP INDEX` is `count − 1` on the last leg, and whether `GPS WP DISTANCE` /
  `GPS ETE` match the aircraft's own display. Record what an EFB-only plan reports here.
