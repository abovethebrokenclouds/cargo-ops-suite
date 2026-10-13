# End-to-end tests

Playwright specs, two projects:

- `demo` — Vite dev server with no connector. Every route must show the DEMO DATA chip and make
  no non-localhost requests.
- `replay` — the real connector (`connector/`, `--sim fake --loop`) serving the
  `CARGO_OPS_LOCAL=1` build. The chip must read REPLAY, `/flight` must bind replayed frames, and
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
  checks the DEMO-tagged used market, systems panel and maintenance board.

Neither project talks to a simulator. A real SimConnect session is only checked on the owner's
Windows PC (see `docs/VERIFICATION.md`).

```sh
bun run build:local
(cd connector && npm ci && npm run build)
bun run e2e                      # CI installs Chromium with `npx playwright install --with-deps chromium`
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bun run e2e   # cloud container with a preinstalled Chromium
```
