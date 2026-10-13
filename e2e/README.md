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
  after arrival.

Neither project talks to a simulator. A real SimConnect session is only checked on the owner's
Windows PC (see `docs/VERIFICATION.md`).

```sh
bun run build:local
(cd connector && npm ci && npm run build)
bun run e2e                      # CI installs Chromium with `npx playwright install --with-deps chromium`
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium bun run e2e   # cloud container with a preinstalled Chromium
```
