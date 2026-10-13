# Cargo Ops connector

The local half of Cargo Ops (plan §3): one Node process on the Windows PC that talks
to Microsoft Flight Simulator through SimConnect, keeps the latest simulator state,
streams it to the browser over a WebSocket on `127.0.0.1:4311`, serves the static web
build and owns the SQLite database.

> **Status: the SimConnect path is untested.** Everything here was built and tested in
> a Linux container without a simulator. `--sim fake` (fixture replay) is covered by
> automated tests; the real SimConnect handshake, SimVar names/units and system
> events must be checked on the Windows PC (see `docs/VERIFICATION.md`).

## Requirements

- Node.js 24 LTS (22.13 or newer also works; `node:sqlite` needs 22.13+).
- npm (ships with Node). Bun is not needed for the connector.

## Commands (run in `connector/`)

| Command                 | What it does                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `npm ci`                | Install the exact dependency versions from `package-lock.json`.           |
| `npm run build`         | Compile to `dist/` (connector + shared protocol).                         |
| `npm start -- [flags]`  | Run `dist/connector/src/cli/main.js`.                                     |
| `npm run typecheck`     | Type-check sources and tests without emitting.                            |
| `npm test`              | Compile sources and tests to `dist-test/` and run them with `node:test`.  |
| `npm run fixtures:sync` | Copy the web demo fixture into `fixtures/` (never edit the copy by hand). |

From the repository root on Windows, `scripts\start-cargo-ops.cmd` does all of this
for you; see `docs/SETUP_WINDOWS.md`.

## CLI

```
--sim simconnect|fake   Data source (default simconnect). fake replays a fixture.
--fixture <path>        Fixture for --sim fake (default fixtures/demo-kmem-katl.jsonl)
--speed <n>             Replay speed multiplier (default 1)
--loop                  Restart the replay when it ends
--record <path>         Append every outgoing frame to a NEW JSONL fixture file
--port <n>              Port on 127.0.0.1 (default 4311; 0 = any free port)
--web <dir>             SPA build to serve (default ../dist/client when present)
--dev-origin [origin]   Also accept this page origin (repeatable); without a value
                        the Vite dev origins http://localhost:8080, http://127.0.0.1:8080
--data-dir <dir>        Config, databases, logs (default below)
--reset-token           Generate a new access token
--open                  Open the browser when ready (start / open / xdg-open)
--verbose               Debug logging
--lan                   Not implemented; refuses to start
--help, --version
```

Examples:

```sh
npm start -- --sim fake --loop --web ../dist/client     # demo replay, cloud/test mode
npm start -- --open --web ../dist/client               # live: waits for MSFS, reconnects
npm start -- --record fixtures/kmem-katl-2026-10-20.jsonl   # record a real flight
```

## Data directory

| OS      | Default                                                  |
| ------- | -------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\CargoOps`                                |
| Others  | `$XDG_CONFIG_HOME/cargo-ops`, else `~/.config/cargo-ops` |

Contents: `config.json` (the access token, 32 random bytes as hex, created on first
run), `cargo-ops.db` (live sessions), `demo.db` (replay sessions; plan §3.2 demo
separation), `logs/connector.log`.

## HTTP and WebSocket API

Bound to `127.0.0.1` only. Every request must carry a `Host` header naming the
connector (`127.0.0.1:<port>` or `localhost:<port>`), which blocks DNS rebinding.

| Route              | Auth                                                            | Response                                         |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/health`  | none                                                            | `{ ok, version, mode, sim }`                     |
| `GET /api/session` | `Origin` absent or an allowed origin                            | `{ token, wsUrl: "/ws" }`                        |
| `GET /api/status`  | `Authorization: Bearer <token>`                                 | health + seq, clients, paths, store stats        |
| other `/api/*`     | Bearer token                                                    | `404` JSON                                       |
| `GET /ws`          | allowed `Origin` **and** token (`?token=` or the first `hello`) | protocol v1 (below)                              |
| `GET /*`           | none                                                            | static SPA; extension-less paths → `_shell.html` |

WebSocket session (`packages/protocol`): the client sends `hello` with the token →
`welcome` (`mode: "live"` with SimConnect, `"replay"` with `--sim fake`; `sim.connected`
is true only after node-simconnect's `open()` resolved) → `snapshot` → `delta`/`event`
frames sharing one monotonic `seq`. `resync` returns a fresh snapshot. The server
pings every 15 s. Commands are answered with `ok: false, error.code: "not_implemented"`
in this version. When the simulator connects or disconnects, every client receives a
new `welcome` + `snapshot`, and simulator-derived domains are cleared on disconnect so
stale values never look live. Close codes: `4401` bad/missing token, `4400` invalid
first message, `4408` no hello within 5 s.

## Protocol sharing

The connector uses the exact zod schemas from `packages/protocol/src` without
copying them and without anything installed at the repository root:

- `tsconfig.json` sets `rootDir: ".."` and includes `../packages/protocol/src/**/*.ts`
  (tests excluded). The output mirrors the repository: `dist/connector/src/...` and
  `dist/packages/protocol/src/...`, both inside `connector/`.
- The connector compiles to CommonJS (`module: commonjs`, `moduleResolution: node10`),
  so the protocol's extension-less relative imports (`./messages`) resolve at runtime.
- `paths: { "zod": ["./node_modules/zod"] }` makes the type checker use the
  connector's own zod even for files under `packages/`. At runtime,
  `require("zod")` from `dist/packages/protocol/src/*.js` walks up to
  `connector/node_modules/zod`.
- `src/protocol.ts` is the single import point (`export * from "../../packages/protocol/src/index"`).

`zod` is pinned to the same version as the web app (3.25.76). If the web app moves to
another zod version, update `connector/package.json` in the same change.

## Layout

```
connector/
  src/sim/       SimSource interface, SimConnectSource, FakeSource,
                 simvars.ts (THE SimVar table), mapping.ts (pure raw → domain functions)
  src/core/      StateStore (snapshot/delta/seq), ConnectorSession (welcome, link),
                 Recorder (JSONL), config (data dir, token), logger
  src/storage/   node:sqlite adapter (WAL, migrations; schema from plan §3.3)
  src/server/    node:http + ws server, origin/host/token checks, static serving
  src/cli/       argument parsing, app composition, main entry point
  test/          node:test suites (compiled to dist-test/)
  fixtures/      replay fixtures (demo-kmem-katl.jsonl is SYNTHETIC; see fixtures/README.md)
  scripts/       clean.mjs, sync-fixtures.mjs
```

## SimConnect notes (unverified until tested on the PC)

- `open("Cargo Ops", Protocol.SunRise)` first, then `Protocol.KittyHawk`; on failure it
  retries with backoff (2 s doubling to 30 s) and reconnects after `quit`/`close`/`error`.
- node-simconnect finds the simulator by itself: `SimConnect.cfg` in the working or
  home directory, else the named pipe, else the port from the registry.
- Data definitions come from `src/sim/simvars.ts`: a `counts` request once per aircraft
  (`NUMBER OF ENGINES`, `PAYLOAD STATION COUNT`, capped at 4 engines / 20 stations), a
  1 Hz `slow` definition and a per-sim-frame `fast` definition throttled to 5 Hz
  (10 Hz below 1,000 ft AGL). If the sim rejects a SimVar, the exception is logged with
  its name, the entry is dropped and the definition rebuilt; dependent domains are then
  simply not reported.
- Entries marked `verified: false`: `SIMULATION RATE`, `PAYLOAD STATION WEIGHT`/`NAME`
  units, `ENG FUEL FLOW PPH`, `IS ON GROUND` (falls back to `SIM ON GROUND`).
- System events: `Pause`, `Pause_EX1`, `SimStart`, `SimStop`, `FlightLoaded`,
  `AircraftLoaded`, `Crashed`, `CrashReset`, `1sec`; `requestSystemState("Sim")` on connect.
- The `sim` domain is only sent once a real `SIMULATION RATE` arrives (the schema needs
  it); until then the chip relies on `welcome.sim`.

## Licensing

`node-simconnect` is LGPL-3.0-or-later. It is an ordinary, unmodified runtime
dependency installed into `node_modules` (its LICENSE ships there) and is never
bundled or copied. See `docs/ASSET_INVENTORY.md` for every dependency and license.
