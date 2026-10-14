// The in-sim toolbar panel package source (msfs-panel/) and its build script, checked in the
// cloud: plain-text sources only, consistent XML references, the configurable port, the
// "Start Cargo Ops" fallback and the host script's behaviour (jsdom). Building the package
// needs the MSFS SDK on Windows and is a PC row (docs/VERIFICATION.md).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const PANEL = join(ROOT, "msfs-panel");
const SOURCES = join(PANEL, "PackageSources");
const HOST_DIR = join(SOURCES, "html_ui/InGamePanels/CargoOpsPanel");
const SCRIPT = join(ROOT, "scripts/build-msfs-panel.ps1");
const CMD = join(ROOT, "scripts/build-msfs-panel.cmd");

const read = (p: string) => readFileSync(p, "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function xml(path: string): Document {
  const doc = new DOMParser().parseFromString(read(path), "application/xml");
  expect(doc.getElementsByTagName("parsererror"), relative(ROOT, path)).toHaveLength(0);
  return doc;
}

const isAscii = (text: string) => [...text].every((c) => c.charCodeAt(0) < 128);

describe("msfs-panel package source", () => {
  it("is plain text only: no SDK files, binaries or compiled packages", () => {
    const allowed = new Set([".xml", ".html", ".js", ".css", ".svg", ".md"]);
    for (const file of walk(PANEL)) {
      expect(allowed.has(extname(file).toLowerCase()), relative(ROOT, file)).toBe(true);
      expect(isAscii(read(file)), `${relative(ROOT, file)} is ASCII`).toBe(true);
    }
  });

  it("project → package definition → asset folders resolve", () => {
    const project = xml(join(PANEL, "cargo-ops-toolbar-panel.xml"));
    const pkgRel = project.getElementsByTagName("Package")[0]?.textContent ?? "";
    expect(pkgRel).toBe("PackageDefinitions\\cargo-ops-toolbar-panel.xml");
    const pkg = xml(join(PANEL, ...pkgRel.split("\\")));
    expect(pkg.documentElement.getAttribute("Name")).toBe("cargo-ops-toolbar-panel");
    const groups = [...pkg.getElementsByTagName("AssetGroup")].map((g) => ({
      type: g.getElementsByTagName("Type")[0]?.textContent,
      dir: g.getElementsByTagName("AssetDir")[0]?.textContent ?? "",
      out: g.getElementsByTagName("OutputDir")[0]?.textContent,
    }));
    expect(groups).toEqual([
      { type: "SPB", dir: "PackageSources\\InGamePanels\\", out: "InGamePanels\\" },
      { type: "Copy", dir: "PackageSources\\html_ui\\", out: "html_ui\\" },
    ]);
    for (const g of groups) {
      expect(statSync(join(PANEL, ...g.dir.split("\\").filter(Boolean))).isDirectory()).toBe(true);
    }
  });

  it("the panel definition points at the page and the icon, with an id the page uses", () => {
    const def = xml(join(SOURCES, "InGamePanels/cargo-ops-toolbar-panel.xml"));
    const panel = def.getElementsByTagName("InGamePanels.InGamePanelDefinition")[0];
    expect(panel).toBeDefined();
    const url = panel!.getAttribute("url") ?? "";
    expect(url).toBe("html_ui/InGamePanels/CargoOpsPanel/CargoOpsPanel.html");
    expect(statSync(join(SOURCES, url)).isFile()).toBe(true);
    const icon = panel!.getAttribute("icon") ?? "";
    expect(icon).toBe("ICON_TOOLBAR_CARGO_OPS");
    const svg = read(join(SOURCES, `html_ui/Textures/Menu/toolbar/${icon}.svg`));
    expect(svg).toContain("<svg");
    const html = read(join(SOURCES, url));
    expect(html).toContain(`panel-id="${panel!.getAttribute("id")}"`);
    for (const attr of ["defaultWidth", "defaultHeight", "minWidth", "minHeight"]) {
      expect(Number(panel!.getAttribute(attr)), attr).toBeGreaterThan(0);
    }
  });

  it("the page has the fallback text, the iframe and loads config.js before the host script", () => {
    const html = read(join(HOST_DIR, "CargoOpsPanel.html"));
    expect(html).toContain("Start Cargo Ops (scripts\\start-cargo-ops.cmd)");
    expect(html).toContain('id="CargoOpsFrame"');
    expect(html).toContain('id="CargoOpsFallback"');
    expect(html.indexOf('src="config.js"')).toBeLessThan(html.indexOf('src="CargoOpsPanel.js"'));
    // No remote resources: only the simulator's own UI files (absolute paths) and ours.
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it("config.js holds the default port in the form the build script rewrites", () => {
    const config = read(join(HOST_DIR, "config.js"));
    expect(config).toMatch(/window\.CARGO_OPS_PANEL_CONFIG = \{ port: 4311 \};/);
    const script = read(SCRIPT);
    expect(script).toContain('[regex]::Replace($text, "port:\\s*\\d+", "port: $Port")');
    expect(config.replace(/port:\s*\d+/, "port: 4312")).toContain("port: 4312");
  });
});

describe("build-msfs-panel.ps1 (static checks; Windows CI runs it: W-47)", () => {
  const script = read(SCRIPT);

  it("is ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)", () => {
    expect(isAscii(script)).toBe(true);
    expect(isAscii(read(CMD))).toBe(true);
  });

  it("offers -WhatIf, -Remove, -DetectOnly, -Community, -SdkPath and -Port, never needs admin", () => {
    expect(script).toContain("[CmdletBinding(SupportsShouldProcess = $true)]");
    for (const p of ["$SdkPath", "$Community", "$Port", "[switch]$Remove", "[switch]$DetectOnly"]) {
      expect(script).toContain(p);
    }
    expect(script).not.toMatch(/RunAsAdministrator|-Verb\s+RunAs/i);
    expect(script).not.toMatch(/\?\?|\?\./); // no PowerShell 7-only operators
  });

  it("finds the SDK via MSFS_SDK / MSFS2024_SDK and names the free SDK docs when missing", () => {
    expect(script).toContain("$env:MSFS_SDK");
    expect(script).toContain("$env:MSFS2024_SDK");
    expect(script).toContain("Tools\\bin\\fspackagetool.exe");
    expect(script).toContain("https://docs.flightsimulator.com/html/Introduction/SDK_Overview.htm");
    expect(script).toContain(
      "https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_Overview.htm",
    );
  });

  it("reads InstalledPackagesPath from UserCfg.opt for both simulators and both stores", () => {
    for (const p of [
      "Packages\\Microsoft.FlightSimulator_8wekyb3d8bbwe\\LocalCache\\UserCfg.opt",
      "Microsoft Flight Simulator\\UserCfg.opt",
      "Packages\\Microsoft.Limitless_8wekyb3d8bbwe\\LocalCache\\UserCfg.opt",
      "Microsoft Flight Simulator 2024\\UserCfg.opt",
    ]) {
      expect(script).toContain(p);
    }
    expect(script).toContain("InstalledPackagesPath");
  });

  it("the .cmd wrapper runs the script with Bypass for this script only", () => {
    expect(read(CMD)).toContain(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-msfs-panel.ps1" %*',
    );
  });
});

// ---- the host script in jsdom ----

interface Host {
  settings: { port: number; origin: string; url: string };
  state: { active: boolean; ready: boolean; attempts: number; fallbackShown: boolean };
  start(): void;
  stop(): void;
}
interface HostApi {
  READY_TIMEOUT_MS: number;
  RETRY_MS: number;
  readConfig(c: unknown): { port: number; origin: string; url: string };
  isReadyMessage(e: unknown, origin: string): boolean;
  createHost(doc: Document, win: Window, config: unknown, timers: unknown): Host;
}

class FakeTimers {
  now = 0;
  private seq = 0;
  private queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.queue.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: number) => {
    this.queue.delete(id);
  };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.queue.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.queue.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

function loadHostApi(): HostApi {
  const code = read(join(HOST_DIR, "CargoOpsPanel.js"));
  const w = window as unknown as Record<string, unknown>;
  w["CARGO_OPS_PANEL_NO_AUTOSTART"] = true;
  new Function("window", code)(window);
  return w["CargoOpsPanelHost"] as HostApi;
}

const api = loadHostApi();

describe("toolbar panel host script", () => {
  let timers: FakeTimers;
  beforeEach(() => {
    const html = read(join(HOST_DIR, "CargoOpsPanel.html"));
    const wrap = /<div id="CargoOpsWrap">[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
    document.body.innerHTML = wrap;
    timers = new FakeTimers();
  });

  const frame = () => document.getElementById("CargoOpsFrame") as HTMLIFrameElement;
  const fallback = () => document.getElementById("CargoOpsFallback") as HTMLElement;
  const ready = (origin: string, data: unknown = { source: "cargo-ops-panel", type: "ready" }) =>
    window.dispatchEvent(new MessageEvent("message", { origin, data }));

  it("reads the port, falling back to 4311 for anything invalid", () => {
    expect(api.readConfig({ port: 4312 }).url).toBe("http://127.0.0.1:4312/panel");
    expect(api.readConfig({ port: "4313" }).port).toBe(4313);
    for (const bad of [
      undefined,
      null,
      {},
      { port: 0 },
      { port: 70000 },
      { port: 1.5 },
      { port: "x" },
    ]) {
      expect(api.readConfig(bad).port).toBe(4311);
    }
  });

  it("loads /panel, shows the fallback when nothing answers and retries", () => {
    const host = api.createHost(document, window, { port: 4312 }, timers);
    expect(document.getElementById("CargoOpsAddress")?.textContent).toBe("http://127.0.0.1:4312");
    host.start();
    expect(frame().getAttribute("src")).toBe("http://127.0.0.1:4312/panel");
    expect(fallback().classList.contains("is-hidden")).toBe(true);

    timers.advance(api.READY_TIMEOUT_MS);
    expect(host.state.fallbackShown).toBe(true);
    expect(fallback().classList.contains("is-hidden")).toBe(false);
    expect(fallback().textContent).toContain("Start Cargo Ops (scripts\\start-cargo-ops.cmd)");

    timers.advance(api.RETRY_MS);
    expect(host.state.attempts).toBe(2);
    expect(host.state.fallbackShown).toBe(true);
    host.stop();
  });

  it("hides the fallback on the ready message from the Cargo Ops origin only", () => {
    const host = api.createHost(document, window, { port: 4312 }, timers);
    host.start();
    timers.advance(api.READY_TIMEOUT_MS);
    expect(host.state.fallbackShown).toBe(true);

    ready("http://127.0.0.1:4311"); // wrong port
    ready("http://evil.test:4312");
    ready("http://127.0.0.1:4312", { source: "cargo-ops-panel", type: "other" });
    ready("http://127.0.0.1:4312", "ready");
    expect(host.state.ready).toBe(false);

    ready("http://127.0.0.1:4312");
    expect(host.state.ready).toBe(true);
    expect(fallback().classList.contains("is-hidden")).toBe(true);
    expect(frame().classList.contains("is-hidden")).toBe(false);
    const attempts = host.state.attempts;
    timers.advance(60_000);
    expect(host.state.attempts).toBe(attempts); // no reloads once loaded
    host.stop();
  });

  it("closing the toolbar window unloads the page and stops retrying", () => {
    const host = api.createHost(document, window, {}, timers);
    host.start();
    host.stop();
    expect(frame().getAttribute("src")).toBe("about:blank");
    timers.advance(60_000);
    expect(host.state.attempts).toBe(1);
    host.start();
    expect(frame().getAttribute("src")).toBe("http://127.0.0.1:4311/panel");
    host.stop();
  });

  it("isReadyMessage needs the exact origin and the constant message", () => {
    const o = "http://127.0.0.1:4311";
    expect(
      api.isReadyMessage({ origin: o, data: { source: "cargo-ops-panel", type: "ready" } }, o),
    ).toBe(true);
    expect(api.isReadyMessage({ origin: o, data: null }, o)).toBe(false);
    expect(api.isReadyMessage(null, o)).toBe(false);
  });
});
