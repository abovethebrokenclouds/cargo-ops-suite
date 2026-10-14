# Cargo Ops — Windows setup

How to run Cargo Ops on the Windows PC that runs Microsoft Flight Simulator 2020 or 2024. Everything runs on this one PC, on `127.0.0.1`; there are no accounts, keys or
cloud services. Opening it from a tablet or a second PC on your home network is an explicit
opt-in (§15).

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
otherwise it uses npm. With Node.js 22 the bundled npm is version 10, which crashes on
this app's dependency tree when installed the usual way; the start script detects
npm older than 11 and installs with `--legacy-peer-deps` instead (it prints
`npm 10.x found (older than 11): installing with --legacy-peer-deps.`). The web app it
builds is the same. Windows CI runs the launcher on Node.js 22.13.0, the newest 22.x and 24.

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
`scripts\start-cargo-ops.cmd --lan` to let a tablet on your home network in (§15), or
`-NoOpen` to skip opening the browser.

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

By default the connector listens only on `127.0.0.1` (loopback), so Windows Defender
Firewall is not expected to ask anything. If a firewall prompt does appear without LAN
access, you can choose **Cancel / do not allow** for all networks — Cargo Ops does not need
network access from other machines. Please note in `docs/VERIFICATION.md` whether a prompt
appeared (PC-17).

**With LAN access on (§15)** the connector also listens on your network, and the first start
shows a **Windows Security Alert** for "Node.js JavaScript Runtime" (Windows remembers the
answer for that `node.exe`; a Node.js installed in another folder asks again):

- tick **Private networks, such as my home or work network**,
- leave **Public networks** unticked,
- press **Allow access**.

Your home Wi-Fi must be set to **Private** for this to work (Settings → Network & internet →
Wi-Fi → your network → Network profile type → Private). On a Public network (café, hotel,
airport) the tablet cannot reach the PC, which is what you want. Changed your mind? Windows
Security → Firewall & network protection → Allow an app through firewall → Node.js
JavaScript Runtime → Private only. Please note in `docs/VERIFICATION.md` what the prompt said
(PC-56).

## 6. Files and the access token

Everything lives in `%LOCALAPPDATA%\CargoOps` (paste that into Explorer's address bar):

| File / folder        | What it is                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `config.json`        | The access token (random, created on first run) and the LAN opt-in. |
| `lan-devices.json`   | Paired LAN devices (token hashes only; §15).                        |
| `cargo-ops.db`       | Your career database (live flights only).                           |
| `demo.db`            | Database used by replays (`--sim fake`), kept separate on purpose.  |
| `logs\connector.log` | Connector log. Attach it when something goes wrong.                 |
| `backups\`           | Daily and on-demand database backups (newest 14 kept).              |

**Token reset:** stop the connector and start it with `--reset-token`
(`scripts\start-cargo-ops.cmd --reset-token`), or delete `config.json`. Reload open
browser tabs afterwards. The token only protects the local API from other web pages;
the page served by the connector fetches it automatically. It is only ever handed to, and
only accepted from, this PC. `--reset-token` also unpairs every LAN device (§15);
deleting `config.json` does not (revoke them in Settings or delete `lan-devices.json`).

Use `--data-dir <folder>` to keep everything somewhere else.

### Backups and restore

While the connector runs it writes a daily copy of the career database to
`%LOCALAPPDATA%\CargoOps\backups\cargo-ops-YYYYMMDD.db` (SQLite `VACUUM INTO`, a consistent
copy even mid-session) and keeps the newest **14** (`--backup-keep 30` keeps more,
`--backup-keep 0` turns the daily backup off). **Settings → Data → Back up now** writes an
extra `cargo-ops-YYYYMMDD-HHMMSS.db` at any time, and the list of backups is shown there.
Replays (`--sim fake`) never write daily backups; their on-demand backups are named
`demo-….db`.

Restoring is done by hand, with the connector **stopped** (there is no restore button on
purpose — replacing an open database is not safe):

1. Close the connector window (or press Ctrl+C in it).
2. Copy the current `cargo-ops.db` somewhere safe.
3. Copy the backup you want over `%LOCALAPPDATA%\CargoOps\cargo-ops.db`.
4. Delete `cargo-ops.db-wal` and `cargo-ops.db-shm` next to it if they exist.
5. Start Cargo Ops again and reload the browser tab.

**Settings → Data** also exports the whole career as one JSON file and imports such a file
(import replaces the current career; back up first).

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
not supported by Cargo Ops yet (`--lan` is about a browser on another device, §15, not
about SimConnect). If a `SimConnect.cfg`
exists in the `connector` folder or your user folder, node-simconnect will use it —
remove it if you are not deliberately connecting to another PC.

## 9. Troubleshooting

| Symptom                                               | Try                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Node.js was not found" / "too old"                   | Install Node.js 24 LTS, then open a **new** Command Prompt.                                                                                                                                            |
| `Port 4311 on 127.0.0.1 is already in use`            | Another connector is running (check other windows) or use `--port 4312` and open that port.                                                                                                            |
| Chip stays `SIM OFFLINE` with MSFS running            | Wait until you are in the world or main menu; check `logs\connector.log` for "SimConnect open … failed" lines. Remove any stray `SimConnect.cfg`.                                                      |
| Log shows `SimConnect rejected "<SimVar>"`            | That SimVar name/unit is wrong for your sim version. The value is just not shown; please report the line (fix goes in `connector\src\sim\simvars.ts`).                                                 |
| Page shows "no web build was found"                   | Run `scripts\start-cargo-ops.cmd -Rebuild`.                                                                                                                                                            |
| Browser says it cannot connect                        | The connector window was closed; start it again.                                                                                                                                                       |
| `node:sqlite is not available`                        | Node.js is older than 22.13; install Node.js 24 LTS.                                                                                                                                                   |
| `Cannot read properties of null (reading 'edgesOut')` | npm 10 (Node.js 22) installed the web app without `--legacy-peer-deps` (older scripts or a manual `npm install`). Update the scripts, install Node.js 24 LTS, or run `npm install --legacy-peer-deps`. |
| `npm ci` fails behind a proxy / offline               | npm needs internet access once to download the connector's three dependencies.                                                                                                                         |
| PowerShell refuses to run the script                  | Use the `.cmd` file; it starts PowerShell with `-ExecutionPolicy Bypass` for this script only.                                                                                                         |

When reporting a problem, include `logs\connector.log` (it never contains the token).

## 10. Map basemap and airport data (optional)

The `/map` page always works offline: it draws a Natural Earth world outline with the
bundled OurAirports airport list. Two better basemaps are picked automatically, in this
order, and a badge in the map corner says which one is active:

1. **Local** — a Protomaps vector extract on your disk, served by the connector at
   `/tiles/basemap.pmtiles` (HTTP range requests, never leaves the PC).
2. **Online** — the free OpenFreeMap `dark` style (`tiles.openfreemap.org`; no key, no
   account, no SLA). Turn it off in **Settings → Basemap → Online maps** to keep the app
   fully offline.
3. **Offline outline** — the bundled Natural Earth countries.

### Download a local basemap

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-basemap.ps1
# optional: a sharper regional extract (served at /tiles/region.pmtiles; the map uses
# basemap.pmtiles today, so name the regional file basemap.pmtiles if you prefer it)
powershell -ExecutionPolicy Bypass -File scripts\fetch-basemap.ps1 -Bbox "-125,24,-66,50" -RegionMaxZoom 11
```

The script downloads the `pmtiles` command-line tool (go-pmtiles, BSD-3-Clause) into
`%LOCALAPPDATA%\CargoOps\basemap\.bin`, then extracts a world z0–7 basemap (expect
roughly 100–200 MB) from a dated Protomaps daily build
(`https://build.protomaps.com/YYYYMMDD.pmtiles`, default: yesterday; pass `-Date
20261012` if that build is gone — daily builds are only kept for a short while) into
`%LOCALAPPDATA%\CargoOps\basemap\basemap.pmtiles`. It prints the file sizes at the end.
Restart the connector (or just reload `/map`): `/api/health` then reports
`basemap.local: true` and the badge reads **Local**. Use `--basemap-dir <folder>` if you
keep the file elsewhere. `scripts/fetch-basemap.sh` does the same on Linux/macOS.

**Licence:** the extract is OpenStreetMap data under the ODbL. The map shows
"© OpenStreetMap contributors (ODbL) · Protomaps" whenever the local basemap is active;
keep that attribution, and never commit `.pmtiles` files (they are git-ignored).

### Refresh the airport list

```powershell
node scripts\refresh-airports.mjs
```

Downloads `airports.csv` and `runways.csv` from OurAirports (public domain) into
`data\ourairports\` (git-ignored) and regenerates `src\assets\data\airports-major.json`
(large and medium airports with the longest runway). `data\ourairports\SOURCE.md` records
the date. Rebuild the web app afterwards (`scripts\start-cargo-ops.cmd -Rebuild`).

## 11. Install as an app (PWA) in Edge or Chrome

Cargo Ops ships a web app manifest and its own icons, served by the connector, so the browser
can install it as a separate window with its own taskbar icon:

1. Start Cargo Ops and open <http://127.0.0.1:4311>.
2. **Edge:** menu `…` → **Apps** → **Install Cargo Ops**. **Chrome:** the install icon at the
   right end of the address bar, or menu `⋮` → **Cast, save and share** → **Install page as
   app…** (older versions: **Install Cargo Ops…**).
3. Launch it from the Start menu like any app. It still needs the connector running: the
   installed window is just the same page without browser chrome.

There is no service worker (nothing is cached offline; the app always talks to the live
connector). Current Chrome and Edge no longer require one for installation; if your browser
does not offer **Install**, use **Create shortcut… → Open as window** instead, and note it in
`docs/VERIFICATION.md`. If you change the port, the installed app keeps the old address —
reinstall it from the new one.

## 12. Shortcuts and starting with Windows

Create Start-menu and desktop shortcuts to the launcher (no administrator rights needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1              # Start menu + desktop
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Startup     # also start with Windows
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Remove -Startup   # undo -Startup
```

`-Startup` puts a shortcut into your Startup folder (`shell:startup`) that runs
`scripts\start-cargo-ops.cmd -NoOpen` in a minimised window, so the connector is up when you
open the installed app. To do it by hand: press Win+R, type `shell:startup`, and create a
shortcut there to `scripts\start-cargo-ops.cmd` with `-NoOpen` appended to the target.

## 13. Why there is no single .exe

The plan allowed an optional single-file connector executable (for example with
`@yao-pkg/pkg`). It is deliberately **not** built: such a tool bundles every dependency into
the executable, and `node-simconnect` is LGPL-3.0-or-later — Cargo Ops keeps it as an
ordinary, unmodified, separately replaceable module in `connector\node_modules` with its
licence text, which is the simple way to honour the LGPL. Packaging an exe that leaves it
outside would save little over the current launcher. `scripts\start-cargo-ops.cmd` (plus
the shortcuts above) is the supported way to start Cargo Ops.

## 14. SimBrief flight plans (optional, off by default)

**Settings → SimBrief flight plan import** can fetch your latest SimBrief OFP: turn it on,
enter **your own** SimBrief username or pilot ID (free SimBrief account; the pilot ID is in
your SimBrief account settings), Save, then **Import latest OFP**. The connector then sends
your username/ID to `www.simbrief.com` (public fetch API, no key) — nothing is sent before you
press Import. The job board shows the planned route and a button that refreshes the board with
contracts from the planned origin to the planned destination.

At most one request per 30 s, 10 s timeout, no automatic retries. The username is stored only
in your local database (`settings` table), never in the repository. The field mapping was
written against SimBrief's documented format and a hand-made sample: please check that the
imported route, fuel and payload match your OFP and note it in `docs/VERIFICATION.md`.

## 15. Tablet or second PC on your home network (LAN access, optional, off by default)

Cargo Ops can show its pages on a tablet, phone or second PC on the same home network while
MSFS and the connector run on this PC. It is off unless you turn it on, and a device gets
nothing until you pair it.

**Turn it on**, either:

- for one run: `scripts\start-cargo-ops.cmd --lan` (every network interface of this PC), or
  `--lan 192.168.1.23` (only that address of this PC; the connector refuses to start with an
  address that is not this PC's); or
- for every start: **Settings → LAN access → Allow LAN access (next start)** on this PC. It
  asks for confirmation (listing the addresses tablets would use) and applies when you restart
  the connector. `--no-lan` keeps it off for one run. If the saved address is no longer this
  PC's (the router gave it another one), the connector starts on 127.0.0.1 only, logs a
  warning and Settings → LAN access says why.

Windows then shows the firewall prompt (§5): **Private networks only**. The connector window
prints the address to open on the tablet, for example `http://192.168.1.23:4311/`, and
**Settings → LAN access** lists it too.

**Pair the tablet:**

1. On this PC open **Settings → LAN access** and press **Generate pairing code**. A code such
   as `K7QM-4XTP` appears with a 5-minute countdown, plus a link
   (`http://192.168.1.23:4311/settings#pair=K7QM4XTP`).
2. On the tablet open the address (or the link, which fills the code in). Cargo Ops shows
   **Pair this device**: type the code, name the device and press **Pair**.
3. The tablet now shows the live pages. It keeps its own device token in that browser; the
   PC's access token never leaves the PC.

A code works once and expires after 5 minutes. Five wrong codes from one device lock it out
for 15 minutes, and ten wrong codes in total cancel the code (Settings → LAN access then says
"Code cancelled after too many wrong attempts — create a new one").

**What a paired device can do:** everything you do while flying — Live Flight, the map, jobs,
loading and starting missions, fleet, loans, FBOs. **What stays on this PC:** career import,
backups (the list and **Back up now**; file paths on this PC are never shown to a tablet), clearing the SimBrief plan (any delete), and LAN access itself (pairing codes,
the setting, the device list). A paired device that tries these gets "only available on the PC
running Cargo Ops".

**Revoke a device:** **Settings → LAN access → Paired devices → Revoke** on this PC. Its open
pages disconnect at once and show **Pair this device** again. `--reset-token` unpairs every
device.

Notes: plain `http` on your own network (no certificate); the browser may say "Not secure",
and the installable app (PWA) only works on this PC. IPv4 only. On this PC keep using
<http://127.0.0.1:4311>: opening the LAN address on the PC itself counts as a LAN device and
asks for a code. Do not forward the port on your router: LAN access is for your home network,
never the internet.

## 16. Toolbar panel inside the simulator (optional)

A **Cargo Ops** button in the simulator's toolbar opens a small window (about 400 x 600) with
the compact, read-only Cargo Ops page: the chip, your active mission, the route source with
distance and ETE, fuel, the payload check, the GO / NO-GO lamps and the weather category at both
ends. It is the page <http://127.0.0.1:4311/panel> shown inside the sim, so Cargo Ops itself
must be running. You build the toolbar package once on this PC; nothing of the SDK is part of
Cargo Ops.

**1. Install the free MSFS SDK (one time).** In the simulator: Options → General →
Developers → turn **Developer Mode** on. In the Developer Mode menu bar open **Help → SDK
Installer** and run the installer (free). SDK pages:
<https://docs.flightsimulator.com/html/Introduction/SDK_Overview.htm> (MSFS 2020) and
<https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_Overview.htm> (MSFS 2024).
Afterwards close every Command Prompt window, so new ones see the SDK's `MSFS_SDK` (or
`MSFS2024_SDK`) environment variable. You can turn Developer Mode off again.

**2. Build and install the panel.** Close the simulator, then double-click
`scripts\build-msfs-panel.cmd` (or run it from a Command Prompt in the repository folder). It:

1. finds the SDK (`MSFS_SDK`, else `MSFS2024_SDK`; or `-SdkPath "C:\MSFS SDK"`),
2. copies `msfs-panel\` to `%LOCALAPPDATA%\CargoOps\msfs-panel-build` and writes the port into
   it (`-Port 4312` if you start Cargo Ops with `--port 4312`),
3. runs the SDK's `fspackagetool.exe` on it (the package tool may start the simulator in the
   background for this and take a few minutes),
4. copies the built `cargo-ops-toolbar-panel` folder into your **Community** folder, which it
   finds in the simulator's `UserCfg.opt` (`InstalledPackagesPath`, Microsoft Store and Steam,
   2020 and 2024). Built with the 2020 SDK it goes to `Community` (MSFS 2024 reads 2020
   packages from there too); built with the 2024 SDK to MSFS 2024's `Community2024`.

No administrator rights are needed. `-DetectOnly` only shows which Community folder(s) it
would use; `-Community "D:\Path\To\Community"` uses that folder instead; `-WhatIf` shows every
step without doing it. Without the SDK it stops with "MSFS SDK not found" and the links above.

**3. Use it.** Start Cargo Ops (`scripts\start-cargo-ops.cmd`), then the simulator, and load a
flight. The **Cargo Ops** button (a crate with an arrow) is in the toolbar at the top of the
screen; if it is not, open the toolbar's edit / customise mode and switch it on. Click it to
open the window; move and resize it like the other toolbar windows. If Cargo Ops is not running
the window says **Start Cargo Ops (scripts\start-cargo-ops.cmd)** and connects by itself as soon
as it is. The window has no buttons: it never changes anything.

**Remove it:** `scripts\build-msfs-panel.cmd -Remove` (deletes `cargo-ops-toolbar-panel` from the
Community folder(s); restart the simulator).

**Security.** The connector lets only `/panel` be shown inside another page, and only by the
simulator's own pages (`coui:`); every other Cargo Ops page refuses to be framed, and the access
token is still only handed to pages from this PC's own address. If the window stays on "Start
Cargo Ops" although Cargo Ops runs, start it once with
`scripts\start-cargo-ops.cmd --panel-frame-ancestor any` (lifts the frame restriction for
`/panel` only) and note in `docs/VERIFICATION.md` (PC-58) whether that helped.

**Honest status:** the package format follows the SDK documentation and community panels, but
it has never been built with the real SDK or shown in a real simulator; that is PC-58. Details
and sources: `msfs-panel\README.md`.
