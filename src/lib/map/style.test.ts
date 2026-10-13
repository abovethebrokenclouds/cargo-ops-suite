import { DARK, layers as protomapsLayers } from "@protomaps/basemaps";
import type { LayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import {
  LAYER_GROUPS,
  MAP_FONT,
  adaptProtomapsLayers,
  floorLayers,
  glyphsUrl,
  localStyle,
  offlineStyle,
  overlayLayers,
  tokenFlavor,
} from "./style";
import type { MapTheme } from "./theme";
import { MAP_TOKENS } from "./theme";

const theme = Object.fromEntries(
  MAP_TOKENS.map((t, i) => [t, { r: i * 10, g: 100, b: 200, a: 1 }]),
) as MapTheme;

describe("map style", () => {
  it("keeps glyph URL braces literal and same-origin", () => {
    expect(glyphsUrl("http://127.0.0.1:4311")).toBe(
      "http://127.0.0.1:4311/map-glyphs/{fontstack}/{range}.pbf",
    );
  });

  it("re-colours every Protomaps flavor colour from tokens and uses one font", () => {
    const flavor = tokenFlavor(DARK, theme);
    const original = DARK as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(flavor)) {
      if (key === "regular" || key === "bold" || key === "italic") {
        expect(value).toBe(MAP_FONT);
      } else if (typeof value === "string") {
        expect(value, key).toMatch(/^rgba\(/);
        expect(value).not.toBe(original[key]);
      }
    }
  });

  it("drops icon layers and rewrites fonts (we ship no sprite and one glyph set)", () => {
    const layers = adaptProtomapsLayers(
      protomapsLayers("protomaps", tokenFlavor(DARK, theme), {
        lang: "en",
      }) as LayerSpecification[],
    );
    const text = JSON.stringify(layers);
    expect(text).not.toMatch(/icon-image/);
    expect(text).not.toMatch(/Noto Sans (Medium|Italic)/);
    expect(layers.some((l) => l.id === "pois")).toBe(false);
    expect(layers.some((l) => l.id === "earth")).toBe(true);
  });

  it("local style points the vector source at the connector via pmtiles:// with OSM credit", () => {
    const style = localStyle("http://127.0.0.1:4311", []);
    const source = style.sources["protomaps"] as { url: string; attribution: string };
    expect(source.url).toBe("pmtiles://http://127.0.0.1:4311/tiles/basemap.pmtiles");
    expect(source.attribution).toMatch(/OpenStreetMap contributors/);
  });

  it("offline style needs no network source", () => {
    const style = offlineStyle(theme, "http://localhost");
    expect(style.sources).toEqual({});
    expect(style.layers.map((l) => l.id)).toEqual(["background"]);
    expect(floorLayers(theme).map((l) => l.id)).toEqual([
      "floor-graticule",
      "floor-land",
      "floor-borders",
    ]);
  });

  it("every toggle group names real overlay layers", () => {
    const ids = new Set(overlayLayers(theme).map((l) => l.id));
    for (const group of Object.values(LAYER_GROUPS)) {
      for (const id of group) expect(ids.has(id), id).toBe(true);
    }
  });
});
