import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { oklabToRgb, readOklchTokens, toHex } from "@/lib/a11y/contrast";

// P6 PWA: the manifest Edge/Chrome read for "Install app". The connector serves it from the
// local build (dist/client) with Content-Type application/manifest+json (connector test).
const publicDir = resolve(__dirname, "../../public");
const manifest = JSON.parse(readFileSync(resolve(publicDir, "manifest.webmanifest"), "utf8")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  id: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("web app manifest", () => {
  it("has the fields browsers need to offer installation", () => {
    expect(manifest.name).toBe("Cargo Ops");
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("uses the --background token's hex for theme and background colours", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const bg = readOklchTokens(css)["background"];
    expect(bg).toBeDefined();
    if (!bg) return;
    const hex = toHex(oklabToRgb(bg));
    expect(manifest.background_color).toBe(hex);
    expect(manifest.theme_color).toBe(hex);
    const root = readFileSync(resolve(__dirname, "../routes/__root.tsx"), "utf8");
    expect(root).toContain(`content: "${hex}"`);
  });

  it("ships 192 and 512 px PNG icons plus a 512 px maskable one, all present and sized", () => {
    const want = [
      { size: 192, purpose: "any" },
      { size: 512, purpose: "any" },
      { size: 512, purpose: "maskable" },
    ];
    for (const w of want) {
      const icon = manifest.icons.find(
        (i) =>
          i.type === "image/png" && i.sizes === `${w.size}x${w.size}` && i.purpose === w.purpose,
      );
      expect(icon, `${w.size} ${w.purpose}`).toBeDefined();
      if (!icon) continue;
      const file = resolve(publicDir, `.${icon.src}`);
      expect(existsSync(file)).toBe(true);
      expect(pngSize(file)).toEqual({ width: w.size, height: w.size });
    }
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(existsSync(resolve(publicDir, `.${icon.src}`)), icon.src).toBe(true);
    }
    expect(pngSize(resolve(publicDir, "icons/apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
  });

  it("is linked from the document head", () => {
    const root = readFileSync(resolve(__dirname, "../routes/__root.tsx"), "utf8");
    expect(root).toContain('rel: "manifest", href: "/manifest.webmanifest"');
  });
});
