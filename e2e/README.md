# End-to-end tests

Playwright specs, two projects:

- `demo` — Vite dev server with no connector. Every route must show the DEMO DATA chip and make
  no non-localhost requests.
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
  `fbo.replay.spec.ts` buys an FBO and flies the mission there. P6: `settings.replay.spec.ts`
  (backup created and listed through the page and `/api/backups`, token masked, SimBrief off by
  default without any request to simbrief.com, manifest/icons content types, `f` map follow);
  `demo.spec.ts` covers `g`-chord navigation, the `?` dialog and units per browser. Weather:
`demo.spec.ts` checks the SAMPLE METARs on `/flight` (category chips, raw text toggle,
observation age, no external request), the job-detail weather toggle and the per-browser
Online weather switch; `replay.spec.ts` checks that a replay's connector serves SAMPLE reports,
never live ones. No spec reaches aviationweather.gov.

Neither project talks to a simulator. A real SimConnect session is only checked on the owner's
Windows PC (see `docs/VERIFICATION.md`).

```sh
bun run build:local
(cd connector && npm ci && npm run build)
bun run e2e                      # CI installs Chromium with `npx playwright install --with-deps chromium`
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bun run e2e   # cloud container with a preinstalled Chromium
```

Order independence: each replay spec passes alone, and the full project passes in its default
order (where `fbo.replay.spec.ts` now runs first):

```sh
for f in used-aircraft settings replay mission fbo; do
  PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bunx playwright test --project=replay --workers=1 e2e/$f*.spec.ts
done
```
