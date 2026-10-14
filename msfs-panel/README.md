# Cargo Ops toolbar panel (MSFS 2020 / 2024)

An optional button in the simulator's toolbar that opens a small window (about 400 x 600)
with the Cargo Ops panel: connection chip, active mission, route source with distance and
ETE, fuel, payload check, the GO / NO-GO lamps and the weather category at both ends.

This folder holds only the **plain-text sources** of the package. You build the package on
your own PC with the free MSFS SDK: `scripts\build-msfs-panel.cmd` (steps in
`docs\SETUP_WINDOWS.md`, "Toolbar panel"). No SDK file, no compiled `.spb` and no built
package is ever part of this repository; the SDK licence covers your own use of its package
tool on your PC.

## How it works

- The window is an ordinary in-game panel page (`CargoOpsPanel.html`) with one iframe. While
  the window is open it loads `http://127.0.0.1:4311/panel` (the port is configurable, see
  below); when the window closes it unloads the page.
- `/panel` is a page of the Cargo Ops web app, served by the connector like every other page.
  It is read-only (no buttons, no links) and labels its data exactly like the other pages:
  DEMO / REPLAY tags, and LIVE only after the connector's welcome says the simulator is
  connected.
- When `/panel` has loaded it sends a constant "ready" message (no data) to the panel page.
  Until that arrives, the panel page shows **Start Cargo Ops (scripts\start-cargo-ops.cmd)**
  and retries every 5 seconds. Once loaded, the Cargo Ops page reconnects by itself if the
  connector restarts (it shows CONNECTOR OFFLINE meanwhile).
- Security: the connector lets **only** `/panel` be shown inside a frame, and only by the
  simulator's own pages (`coui:`) and itself; every other page keeps `X-Frame-Options: DENY`
  and `frame-ancestors 'none'`, and the web app refuses to render any other page inside a
  frame. The access token still only goes to same-origin requests from this PC
  (`GET /api/session`). Details: `connector/src/server/security.ts`.

## Files

| File                                                                      | What it is                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cargo-ops-toolbar-panel.xml`                                             | package tool project (one package)                                |
| `PackageDefinitions/cargo-ops-toolbar-panel.xml`                          | package definition: an `SPB` asset group and a `Copy` asset group |
| `PackageSources/InGamePanels/cargo-ops-toolbar-panel.xml`                 | the in-game panel definition (compiled to an `.spb` by the tool)  |
| `PackageSources/html_ui/InGamePanels/CargoOpsPanel/CargoOpsPanel.*`       | the panel page, its script and style                              |
| `PackageSources/html_ui/InGamePanels/CargoOpsPanel/config.js`             | the connector port (default 4311)                                 |
| `PackageSources/html_ui/Textures/Menu/toolbar/ICON_TOOLBAR_CARGO_OPS.svg` | toolbar icon, drawn for this project                              |

## Build and install

```bat
scripts\build-msfs-panel.cmd                 :: build with the SDK, copy to Community
scripts\build-msfs-panel.cmd -Port 4312      :: the connector runs with --port 4312
scripts\build-msfs-panel.cmd -DetectOnly     :: show the Community folder(s), change nothing
scripts\build-msfs-panel.cmd -Remove         :: take the panel out again
```

The script finds the SDK through the `MSFS_SDK` or `MSFS2024_SDK` environment variable (or
`-SdkPath`), runs `<SDK>\Tools\bin\fspackagetool.exe` on a copy of this folder (with the port
written into `config.js`) in `%LOCALAPPDATA%\CargoOps\msfs-panel-build`, and copies the built
`cargo-ops-toolbar-panel` package into the Community folder it reads from each simulator's
`UserCfg.opt` (`InstalledPackagesPath`), or into `-Community <folder>`. With the 2020 SDK the
package goes to `Community` (both simulators read 2020 packages from there); with the 2024 SDK
to MSFS 2024's `Community2024`. It never needs administrator rights.

Building by hand works too: change the port in `config.js` if needed, run
`fspackagetool.exe cargo-ops-toolbar-panel.xml -nopause` in this folder and copy
`Packages\cargo-ops-toolbar-panel` into your Community folder (both `Packages\` and
`_PackageInt\` are git-ignored).

## Sources (facts only, nothing copied)

Read on 2026-10-14. Names and layouts were taken from these; no code or file was copied.

- MSFS 2024 SDK documentation (docs.flightsimulator.com/msfs2024): _SDK Overview_ ("The
  Community Folders": `Community` for MSFS 2020 packages, `Community2024` for MSFS 2024
  packages; SDK download from the Help menu in Developer Mode), _The Package Tool_
  (`<SDK_Root>\Tools\bin\fspackagetool.exe`, options `-outputdir`, `-tempdir`, `-rebuild`,
  `-mirroring`, `-forcesteam`, `-nopause`; it runs the simulator executable to build),
  _Package Tool XML Properties_ (`AssetPackage`, `ItemSettings`, `ContentType` `MISC`,
  `Flags`, `AssetGroup`, `AssetDir`, `OutputDir`), _Components And Concepts_ and _Asset
  Types_ (`SPB` and `Copy` asset groups).
- MSFS 2020 SDK documentation (docs.flightsimulator.com/html): _The Package Tool_ (same
  location and options, including `-nopause`), _SDK Overview_ (Community folder).
- The public community template `bymaximus/msfs2020-toolbar-window-template` (GitHub; it has no
  licence file, so it is treated as ideas-only): the project file layout
  (`Project Version="2" ... FolderName="Packages"`), the `SimBase.Document Type="InGamePanels"`
  file with an `InGamePanels.InGamePanelDefinition` element and its attribute names (`id`,
  `Name`, `url`, `resizeDirections`, `minWidth`, `minHeight`, `defaultWidth`, `defaultHeight`,
  `icon`, `buttonVisible`), the toolbar icon location
  `html_ui\Textures\Menu\toolbar\ICON_TOOLBAR_<NAME>.svg`, the simulator UI files a panel page
  includes, the `ingame-ui` element with `panel-id`, and the `panelActive` / `panelInactive`
  events. Its README also notes that a site sending `X-Frame-Options: SAMEORIGIN` cannot be
  shown in such a panel, which is why the connector drops that header for `/panel` only.
- The idea itself (a toolbar panel that shows a local web server's page) is the community
  pattern also used by Little Navmap's in-game panel (GPL, ideas only; Little Navmap's own web
  server docs: `http://localhost:8965`).
- `UserCfg.opt` locations (Microsoft Store and Steam, 2020 and 2024) and the
  `InstalledPackagesPath` line: community-documented; not verifiable here, so `-Community` and
  `-DetectOnly` exist.

## Not verified here (needs the owner's PC: docs/VERIFICATION.md PC-58)

The package tool cannot run in the cloud (Windows, the simulator and the SDK are needed).
Unverified until PC-58: that the real tool builds this folder; the size units of the panel
definition (community panels use what look like screen percentages; the values aim at about
400 x 600 on 1920 x 1080); that the simulator's pages identify as `coui:` for the
`frame-ancestors` check (if the window stays on "Start Cargo Ops" while the connector runs,
start the connector with `--panel-frame-ancestor any`, which lifts the frame restriction for
`/panel` only); that the simulator's HTML engine renders the Cargo Ops page and passes the
ready message; the MSFS 2024 behaviour of a 2020-built package; and the `MSFS2024_SDK`
variable name.
