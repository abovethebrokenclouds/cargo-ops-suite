# Cargo Ops — Windows setup

How to run Cargo Ops on the Windows PC that runs Microsoft Flight Simulator 2020 or 2024. Everything runs on this one PC, on `127.0.0.1`; there are no accounts, keys or
cloud services.

> **Honest status:** the connector's SimConnect path has been type-checked and its
> mapping logic unit-tested, but it has **never been run against a real simulator**.
> The first run on your PC is the test. Please work through the checklist in
> `docs/VERIFICATION.md` ("Requires Windows PC with MSFS") and note what you see.

## 1. Install Node.js (one time)

1. Download **Node.js 24 LTS** from <https://nodejs.org> (the "LTS" button, Windows
   installer `.msi`).
2. Run the installer with the default options. "Tools for native modules" is not
   needed; Cargo Ops uses no native addons.
3. Open a new Command Prompt and check: `node --version` should print `v24.x.x`.
   (22.13 or newer also works.)

Bun is optional. If it is installed, the start script uses it to build the web app;
otherwise it uses npm.

## 2. Get the code

```bat
git clone <your repository URL> cargo-ops-suite
cd cargo-ops-suite
```

(Or download the repository as a ZIP from GitHub and extract it.)

## 3. Start Cargo Ops

Double-click `scripts\start-cargo-ops.cmd`, or run it from a Command Prompt:

```bat
scripts\start-cargo-ops.cmd
```

The first run takes a few minutes. It:

1. checks Node.js,
2. installs the connector's dependencies (`npm ci` in `connector\`),
3. builds the web app into `dist\client` if it is not there yet,
4. builds the connector,
5. starts it on <http://127.0.0.1:4311> and opens your browser.

Leave the window open while you fly; press **Ctrl+C** (or close the window) to stop.
After pulling new code, run `scripts\start-cargo-ops.cmd -Rebuild` once so the web app
is rebuilt. `scripts\build-local.ps1` builds without starting.

Extra arguments go to the connector, for example
`scripts\start-cargo-ops.cmd --sim fake --loop` for a replay without the simulator,
or `-NoOpen` to skip opening the browser.

## 4. What the status chip shows

The chip in the top navigation always tells you where the numbers come from:

| Chip                                     | Meaning                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CONNECTING`                             | The page is reaching the connector.                                                                                                    |
| `SIM OFFLINE`                            | The connector runs, but MSFS is not connected (not started, or in a menu before SimConnect is up). It retries every 2–30 s on its own. |
| `LIVE · MSFS 2024 · SunRise`             | Connected to MSFS 2024 with the SunRise protocol.                                                                                      |
| `LIVE · MSFS 2020 · KittyHawk`           | Connected to MSFS 2020 (KittyHawk fallback).                                                                                           |
| `REPLAY`                                 | The connector is replaying a fixture (`--sim fake`). Not live data.                                                                    |
| `CONNECTOR OFFLINE` / `CONNECTION ERROR` | The page cannot reach the connector. Is the window still open?                                                                         |
| `DEMO DATA`                              | You opened the Lovable preview or a dev server, not the connector.                                                                     |

The simulator name (2020/2024) is derived from SimConnect's open response and is one
of the things to confirm on the first run.

## 5. Firewall

The connector listens only on `127.0.0.1` (loopback), so Windows Defender Firewall is
not expected to ask anything. If a firewall prompt does appear, you can choose
**Cancel / do not allow** for all networks — Cargo Ops does not need network access
from other machines. Please note in `docs/VERIFICATION.md` whether a prompt appeared.

## 6. Files and the access token

Everything lives in `%LOCALAPPDATA%\CargoOps` (paste that into Explorer's address bar):

| File / folder        | What it is                                                         |
| -------------------- | ------------------------------------------------------------------ |
| `config.json`        | The access token (random, created on first run).                   |
| `cargo-ops.db`       | Your career database (live flights only).                          |
| `demo.db`            | Database used by replays (`--sim fake`), kept separate on purpose. |
| `logs\connector.log` | Connector log. Attach it when something goes wrong.                |

**Token reset:** stop the connector and start it with `--reset-token`
(`scripts\start-cargo-ops.cmd --reset-token`), or delete `config.json`. Reload open
browser tabs afterwards. The token only protects the local API from other web pages;
the page served by the connector fetches it automatically.

Use `--data-dir <folder>` to keep everything somewhere else.

## 7. Recording your first real fixture

A fixture is a JSONL recording of what the connector sent. A real one lets us test
the flight-tracking features against genuine MSFS data in the cloud.

1. Start MSFS and load a flight (any aircraft; a short hop is ideal).
2. In a Command Prompt in the repository folder (paths you pass are relative to the
   folder you run the command from):

   ```bat
   scripts\start-cargo-ops.cmd --record connector\fixtures\kmem-katl-2026-10-20.jsonl
   ```

   Use a new file name each time; the connector refuses to append to an existing
   recording.

3. Check the chip says `LIVE · …`, then fly. Pause once and change the sim rate once
   so those events are captured.
4. Press Ctrl+C after parking. Check the file replays:

   ```bat
   scripts\start-cargo-ops.cmd --sim fake --fixture connector\fixtures\kmem-katl-2026-10-20.jsonl
   ```

   The chip should say `REPLAY`.

5. Commit the file (without the `demo-` prefix) and add a line to
   `connector\fixtures\README.md` with the simulator, aircraft and date.

Frames in a real recording carry `source: "sim"`; replays always relabel them
`replay`, so a recording can never be mistaken for a live connection.

## 8. SimConnect configuration

Nothing to configure when MSFS and Cargo Ops run on the **same PC**: node-simconnect
finds the simulator through its named pipe / the registry once MSFS has started.

`SimConnect.xml` (on the simulator PC) and `SimConnect.cfg` (on the client) are only
needed if you ever run the connector on a **different** PC than MSFS. That setup is
not supported by Cargo Ops yet (`--lan` is not implemented). If a `SimConnect.cfg`
exists in the `connector` folder or your user folder, node-simconnect will use it —
remove it if you are not deliberately connecting to another PC.

## 9. Troubleshooting

| Symptom                                    | Try                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Node.js was not found" / "too old"        | Install Node.js 24 LTS, then open a **new** Command Prompt.                                                                                            |
| `Port 4311 on 127.0.0.1 is already in use` | Another connector is running (check other windows) or use `--port 4312` and open that port.                                                            |
| Chip stays `SIM OFFLINE` with MSFS running | Wait until you are in the world or main menu; check `logs\connector.log` for "SimConnect open … failed" lines. Remove any stray `SimConnect.cfg`.      |
| Log shows `SimConnect rejected "<SimVar>"` | That SimVar name/unit is wrong for your sim version. The value is just not shown; please report the line (fix goes in `connector\src\sim\simvars.ts`). |
| Page shows "no web build was found"        | Run `scripts\start-cargo-ops.cmd -Rebuild`.                                                                                                            |
| Browser says it cannot connect             | The connector window was closed; start it again.                                                                                                       |
| `node:sqlite is not available`             | Node.js is older than 22.13; install Node.js 24 LTS.                                                                                                   |
| `npm ci` fails behind a proxy / offline    | npm needs internet access once to download the connector's three dependencies.                                                                         |
| PowerShell refuses to run the script       | Use the `.cmd` file; it starts PowerShell with `-ExecutionPolicy Bypass` for this script only.                                                         |

When reporting a problem, include `logs\connector.log` (it never contains the token).
