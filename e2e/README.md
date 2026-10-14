# End-to-end tests

Playwright specs, two projects:

- `demo` — the production SSR build (`bun run build` → `.output`, what Lovable publishes) served
  by `e2e/serve-ssr.mjs` (plain Node running the worker's own `fetch` handler), no connector.
  Every route must show the DEMO DATA chip and make no non-localhost requests.
  `E2E_DEMO_DEV=1` runs the same specs on the Vite dev server instead; it is much slower to
  hydrate (about 240 unbundled module requests after the load event against about 30), which
  is why CI does not use it.
- `replay` — the real connector (`connector/`, `--sim fake --loop`) serving the
  `CARGO_OPS_LOCAL=1` build. **Each replay spec file starts its own connector** on a free port
  with a fresh temporary data dir (`e2e/replay-fixtures.ts`: import `test`/`expect` from there),
  so specs never share a company and can run alone or in any order; there is no test-only
  endpoint in the connector. The chip must read REPLAY, `/flight` must bind replayed frames, and
  the security checks (foreign Origin, path traversal) must hold. The connector replays at 20×
  (`CARGO_OPS_E2E_SPEED` overrides it) so `/flight` reaches a connector-graded landing quickly.
  `mission.replay.spec.ts` flies a full mission (board → accept → load → replayed flight →
  delivered) and asserts the payout through `/api/missions`, `/api/logbook`, the CSV export and
  the `/logbook` table, because a new replay pass clears the live flight state about a second
  after arrival. Since P4 it also checks, through `/api/ledger` and `/api/fleet`, that the leg
  booked fuel at the landing airport's price and the landing fee, that the ledger balances and
  that the aircraft moved and wore as computed; the demo specs check that `/company` and `/fleet`
  show DEMO-tagged seeded data with every action disabled. P5: `used-aircraft.replay.spec.ts`
  exercises the airworthiness gate through the connector API (WebSocket commands sent from the
  page's own origin + `/api` reads): a used aircraft whose uninspected purchase hides a grounding
  defect (picked deterministically from the replay company's seed) is refused on its first
  dispatch with `grounding_defect`, and the repair lands on the maintenance board; the demo spec
  checks the DEMO-tagged used market, systems panel and maintenance board. P5 part 2:
  `fbo.replay.spec.ts` buys an FBO and flies the mission there. Transit cargo:
  `transit.replay.spec.ts` loads a KMEM → KRDU job on a leg to KATL ("Leg to"), lets the replay
  fly it, and checks that the job waits at KATL in transit, unpaid, on `/api/jobs`, `/jobs`
  (location, destination, deadline, REPLAY) and as a `/map` pin (the onward leg is the
  connector's two-leg replay test). P6: `settings.replay.spec.ts`
  (backup created and listed through the page and `/api/backups`, token masked, SimBrief off by
  default without any request to simbrief.com, manifest/icons content types, `f` map follow);
  `demo.spec.ts` covers `g`-chord navigation, the `?` dialog and units per browser. Weather:
  `demo.spec.ts` checks the SAMPLE METARs on `/flight` (category chips, raw text toggle,
  observation age, no external request) and the destination SAMPLE TAF timeline (a category per
  period, raw text), the job-detail weather toggle, the `/map` METAR badges (SAMPLE legend with
  VFR/MVFR dots for KMEM/KATL, two features on the badge layer, the raw-METAR tooltip with its
  age, the layer toggle) and the per-browser Online weather switch; `replay.spec.ts` checks that
  a replay's connector serves SAMPLE METARs and TAFs, never live ones. No spec reaches
  aviationweather.gov.

- `live` — `sim-offline.live.spec.ts` starts the real connector in SimConnect mode
  (`--simconnect-host/--simconnect-port`, `--weather off`) against the TEST-ONLY SimConnect
  protocol emulator (`connector/test/support/simconnect-emulator.ts`): `/flight` shows LIVE and
  Cruise; when the emulated simulator quits the chip reads SIM OFFLINE, the phase and every
  readout are empty and the data light reads SIM OFF (never SIM); after it is back the phase
  returns from new frames. Emulated evidence about our code, not about MSFS.

No project talks to a real simulator. A real SimConnect session is only checked on the owner's
Windows PC (see `docs/VERIFICATION.md`).

```sh
bun run build                    # SSR build for the demo project (rebuild after web changes)
bun run build:local
(cd connector && npm ci && npm run build)
bun run e2e                      # CI installs Chromium with `npx playwright install --with-deps chromium`
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bun run e2e   # cloud container with a preinstalled Chromium
```

Order independence: each replay spec passes alone, and the full project passes in its default
order (where `fbo.replay.spec.ts` now runs first):

```sh
for f in used-aircraft settings replay mission fbo transit; do
  PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bunx playwright test --project=replay --workers=1 e2e/$f*.spec.ts
done
```

Environment knobs: `E2E_PORT` (demo server port, default 5180; `scripts/gate.sh` picks a free
one so parallel worktrees never collide), `E2E_REUSE_SERVER=1` (reuse a server already on that
port, never in CI), `E2E_DEMO_DEV=1` (demo project on the dev server), `E2E_CPU_THROTTLE=6`
(demo pages run with Chromium's CPU throttling, to reproduce slow-runner timing locally).
