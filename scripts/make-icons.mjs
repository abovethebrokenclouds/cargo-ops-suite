#!/usr/bin/env node
// Rasterises the in-house SVG app icons (public/icons/icon.svg, icon-maskable.svg) into the
// PNGs the web app manifest and the page head reference, and writes public/favicon.ico.
// Uses Playwright's Chromium (already a dev dependency); no image library needed.
//
//   node scripts/make-icons.mjs                      # Playwright-managed Chromium
//   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "public", "icons");
const svg = {
  icon: readFileSync(join(icons, "icon.svg"), "utf8"),
  maskable: readFileSync(join(icons, "icon-maskable.svg"), "utf8"),
};

const outputs = [
  { file: "icon-192.png", src: "icon", size: 192 },
  { file: "icon-512.png", src: "icon", size: 512 },
  { file: "icon-maskable-512.png", src: "maskable", size: 512 },
  { file: "apple-touch-icon.png", src: "maskable", size: 180 },
];
const favicon = [48, 32, 16];

const executablePath = process.env["PW_CHROMIUM_PATH"];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (source, size) => {
    await page.setViewportSize({ width: size, height: size });
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">` +
        `<img src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    await page.locator("img").evaluate((img) => img.decode());
    return page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
  };
  for (const o of outputs) {
    const png = await render(svg[o.src], o.size);
    writeFileSync(join(icons, o.file), png);
    console.log(`public/icons/${o.file}  ${o.size}x${o.size}  ${png.length} bytes`);
  }
  // ICO with embedded PNGs (supported by every current browser and Windows Vista+).
  const images = [];
  for (const size of favicon) images.push({ size, png: await render(svg.icon, size) });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  const ico = Buffer.concat([header, dir, ...images.map((i) => i.png)]);
  writeFileSync(join(root, "public", "favicon.ico"), ico);
  console.log(`public/favicon.ico  ${favicon.join("/")} px  ${ico.length} bytes`);
} finally {
  await browser.close();
}
