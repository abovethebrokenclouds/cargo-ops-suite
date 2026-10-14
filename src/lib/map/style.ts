// MapLibre style pieces for the ops map: basemap styles (local PMTiles, offline floor),
// the Protomaps flavor re-coloured from design tokens, and the app overlay layers.
// Every colour is derived from a MapTheme (CSS tokens); none is defined here.

import type { Flavor } from "@protomaps/basemaps";
import type { FeatureCollection, Geometry } from "geojson";
import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";

import { mix, toCss, withAlpha, type MapTheme, type Rgba } from "./theme";

/** The one glyph font shipped in public/map-glyphs (OFL-1.1). */
export const MAP_FONT = "Noto Sans Regular";
/** Online fallback style (no key; attribution comes with the style's sources). */
export const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
/** Local basemap served by the connector (HTTP range requests). */
export const LOCAL_BASEMAP_PATH = "/tiles/basemap.pmtiles";

export const ATTRIBUTION = {
  osmProtomaps:
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> (ODbL) · <a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>',
  naturalEarth:
    '<a href="https://www.naturalearthdata.com" target="_blank" rel="noreferrer">Natural Earth</a>',
  ourAirports: '<a href="https://ourairports.com" target="_blank" rel="noreferrer">OurAirports</a>',
} as const;

export type BasemapKind = "local" | "online" | "offline";

export const BASEMAP_LABEL: Record<BasemapKind, string> = {
  local: "Local",
  online: "Online",
  offline: "Offline outline",
};

/** Same-origin glyph URL template; braces must stay literal for MapLibre. */
export function glyphsUrl(origin: string): string {
  return `${origin}/map-glyphs/{fontstack}/{range}.pbf`;
}

const c = toCss;

/** Background-only style; the offline floor and overlays are added on load. */
export function offlineStyle(theme: MapTheme, origin: string): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl(origin),
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": c(mix(theme.background, theme.primary, 0.035)) },
      },
    ],
  };
}

// ---- Protomaps flavor from tokens ----

function flavorColor(key: string, t: MapTheme): Rgba {
  const land = mix(t.card, t.background, 0.35);
  const road = mix(t.secondary, t["muted-foreground"], 0.18);
  if (key === "background") return mix(t.background, t.primary, 0.03);
  if (key === "earth") return land;
  if (key === "water") return mix(t.background, t.primary, 0.06);
  if (key === "aerodrome") return mix(land, t.primary, 0.12);
  if (key === "runway") return mix(t.secondary, t.accent, 0.22);
  if (key === "buildings") return mix(land, t.secondary, 0.6);
  if (key === "boundaries") return withAlpha(t["muted-foreground"], 0.45);
  if (key === "railway") return mix(road, t.background, 0.3);
  if (key.endsWith("_halo")) return withAlpha(t.background, 0.9);
  if (key === "country_label" || key === "city_label") return t.foreground;
  if (key.endsWith("_label")) return t["muted-foreground"];
  if (/casing/.test(key)) return mix(land, t.background, 0.4);
  if (/highway|major|minor|link|other|pier|tunnel|bridges/.test(key)) {
    return /highway|major/.test(key) ? mix(road, t.primary, 0.12) : road;
  }
  // Land use, parks, landcover: a whisper above the land tone.
  return mix(land, t.secondary, 0.35);
}

/** Protomaps flavor with every colour replaced by a token-derived one and our single font. */
export function tokenFlavor(base: Flavor, theme: MapTheme): Flavor {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") out[key] = c(flavorColor(key, theme));
    else if (value && typeof value === "object") {
      const nested: Record<string, string> = {};
      for (const sub of Object.keys(value)) nested[sub] = c(flavorColor(sub, theme));
      out[key] = nested;
    }
  }
  out["regular"] = MAP_FONT;
  out["bold"] = MAP_FONT;
  out["italic"] = MAP_FONT;
  return out as unknown as Flavor;
}

/**
 * Prepare Protomaps layers for our assets: we ship no sprite, so icon-only layers are
 * dropped and icons removed from the rest, and every font becomes MAP_FONT.
 */
export function adaptProtomapsLayers(layers: LayerSpecification[]): LayerSpecification[] {
  const dropped = new Set(["pois", "roads_shields", "roads_oneway"]);
  return layers
    .filter((l) => !dropped.has(l.id))
    .map((l) => {
      const text = JSON.stringify(l).replace(/Noto Sans (Medium|Italic|Bold)/g, MAP_FONT);
      const layer = JSON.parse(text) as LayerSpecification;
      if (layer.type === "symbol" && layer.layout && "icon-image" in layer.layout) {
        const layout = { ...layer.layout };
        delete layout["icon-image"];
        layer.layout = layout;
      }
      return layer;
    });
}

export function localStyle(
  origin: string,
  basemapLayers: LayerSpecification[],
): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl(origin),
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${origin}${LOCAL_BASEMAP_PATH}`,
        attribution: ATTRIBUTION.osmProtomaps,
      },
    },
    layers: basemapLayers,
  };
}

// ---- Offline floor (world-atlas 110m, Natural Earth) ----

export const FLOOR_SOURCE = "floor-countries";
export const GRATICULE_SOURCE = "floor-graticule";

export function floorLayers(theme: MapTheme): LayerSpecification[] {
  return [
    {
      id: "floor-graticule",
      type: "line",
      source: GRATICULE_SOURCE,
      paint: {
        "line-color": c(withAlpha(theme.primary, 0.09)),
        "line-width": 0.6,
      },
    },
    {
      id: "floor-land",
      type: "fill",
      source: FLOOR_SOURCE,
      paint: {
        "fill-color": c(mix(mix(theme.card, theme.secondary, 0.55), theme.primary, 0.04)),
        "fill-opacity": 0.95,
      },
    },
    {
      id: "floor-borders",
      type: "line",
      source: FLOOR_SOURCE,
      paint: {
        "line-color": c(withAlpha(mix(theme["muted-foreground"], theme.primary, 0.4), 0.5)),
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1.1],
      },
    },
  ];
}

// ---- App overlays ----

export const OVERLAY_SOURCES = {
  route: "ops-route",
  trail: "ops-trail",
  airports: "ops-airports",
  metar: "ops-metar",
} as const;

/** METAR flight-category badge layer (hover/click shows the raw report). */
export const METAR_BADGE_LAYER = "ops-metar-badge";

export const LAYER_GROUPS = {
  route: ["ops-route-glow", "ops-route-line"],
  trail: ["ops-trail-glow", "ops-trail-line"],
  airports: ["ops-airports-halo", "ops-airports-dot", "ops-airports-label"],
  weather: [METAR_BADGE_LAYER],
} as const;
export type OverlayGroup = keyof typeof LAYER_GROUPS;

/** A fresh empty FeatureCollection. */
export function emptyFc(): FeatureCollection<Geometry> {
  return { type: "FeatureCollection", features: [] };
}

export function overlaySources(): Record<string, SourceSpecification> {
  return {
    [OVERLAY_SOURCES.route]: { type: "geojson", data: emptyFc() },
    [OVERLAY_SOURCES.trail]: { type: "geojson", data: emptyFc(), lineMetrics: true },
    [OVERLAY_SOURCES.airports]: {
      type: "geojson",
      data: emptyFc(),
      attribution: ATTRIBUTION.ourAirports,
    },
    [OVERLAY_SOURCES.metar]: { type: "geojson", data: emptyFc() },
  };
}

/**
 * Flight-category badge: a small dot up and to the right of the airport, so it stays visible
 * next to the origin/destination markers. Colour from the --vfr/--mvfr/--ifr/--lifr tokens;
 * a report without a category is drawn in the muted tone.
 */
export function metarBadgeLayer(theme: MapTheme): LayerSpecification {
  return {
    id: METAR_BADGE_LAYER,
    type: "circle",
    source: OVERLAY_SOURCES.metar,
    paint: {
      "circle-color": [
        "match",
        ["get", "category"],
        "VFR",
        c(theme.vfr),
        "MVFR",
        c(theme.mvfr),
        "IFR",
        c(theme.ifr),
        "LIFR",
        c(theme.lifr),
        c(theme["muted-foreground"]),
      ],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 9, 6],
      "circle-translate": [11, -11],
      "circle-stroke-color": c(withAlpha(theme.background, 0.9)),
      "circle-stroke-width": 1.5,
      // A stale live report is drawn faded.
      "circle-opacity": ["case", ["==", ["get", "stale"], true], 0.55, 1],
    },
  };
}

export function overlayLayers(theme: MapTheme): LayerSpecification[] {
  return [
    {
      id: "ops-airports-halo",
      type: "circle",
      source: OVERLAY_SOURCES.airports,
      minzoom: 3,
      paint: {
        "circle-color": c(withAlpha(theme.accent, 0.14)),
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3,
          ["match", ["get", "type"], "large", 4, 2],
          9,
          ["match", ["get", "type"], "large", 12, 8],
        ],
        "circle-blur": 0.6,
      },
    },
    {
      id: "ops-airports-dot",
      type: "circle",
      source: OVERLAY_SOURCES.airports,
      filter: ["any", ["==", ["get", "type"], "large"], [">=", ["zoom"], 5]],
      paint: {
        "circle-color": [
          "match",
          ["get", "type"],
          "large",
          c(mix(theme.accent, theme.foreground, 0.15)),
          c(mix(theme.accent, theme.background, 0.35)),
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2,
          ["match", ["get", "type"], "large", 1.6, 1],
          9,
          ["match", ["get", "type"], "large", 4.5, 3],
        ],
        "circle-stroke-color": c(withAlpha(theme.background, 0.85)),
        "circle-stroke-width": 0.8,
      },
    },
    {
      id: "ops-airports-label",
      type: "symbol",
      source: OVERLAY_SOURCES.airports,
      minzoom: 5,
      filter: ["any", ["==", ["get", "type"], "large"], [">=", ["zoom"], 7.5]],
      layout: {
        "text-field": ["get", "ident"],
        "text-font": [MAP_FONT],
        "text-size": 11,
        "text-offset": [0, 1.05],
        "text-anchor": "top",
        "text-letter-spacing": 0.08,
        "text-optional": true,
      },
      paint: {
        "text-color": c(mix(theme.accent, theme.foreground, 0.4)),
        "text-halo-color": c(withAlpha(theme.background, 0.9)),
        "text-halo-width": 1.4,
      },
    },
    {
      id: "ops-route-glow",
      type: "line",
      source: OVERLAY_SOURCES.route,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c(withAlpha(theme.accent, 0.55)),
        "line-width": 12,
        "line-blur": 9,
      },
    },
    {
      id: "ops-route-line",
      type: "line",
      source: OVERLAY_SOURCES.route,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c(mix(theme.accent, theme.foreground, 0.2)),
        "line-width": 2.2,
        "line-dasharray": [2, 1.5],
      },
    },
    {
      id: "ops-trail-glow",
      type: "line",
      source: OVERLAY_SOURCES.trail,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c(withAlpha(theme.tertiary, 0.6)),
        "line-width": 11,
        "line-blur": 8,
      },
    },
    {
      id: "ops-trail-line",
      type: "line",
      source: OVERLAY_SOURCES.trail,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": 3,
        "line-gradient": [
          "interpolate",
          ["linear"],
          ["line-progress"],
          0,
          c(withAlpha(theme.tertiary, 0.15)),
          0.6,
          c(theme.tertiary),
          1,
          c(mix(theme.tertiary, theme.foreground, 0.35)),
        ],
      },
    },
    metarBadgeLayer(theme),
  ];
}
