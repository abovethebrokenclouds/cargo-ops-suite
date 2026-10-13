// MapLibre wrapper for the ops map. MapLibre (and its CSS, PMTiles and the world
// outline) are imported dynamically inside an effect, so nothing map-related runs during
// server render or the first client render, and the library stays in its own chunk.

import type { FeatureCollection, Geometry } from "geojson";
import type {
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  Marker,
  Popup,
  StyleSpecification,
} from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { airportsGeoJson, type Airport, type AirportIndex } from "@/lib/map/airports";
import { chooseBasemap } from "@/lib/map/basemap";
import { graticuleLines, type LonLat } from "@/lib/map/geo";
import type { RouteEnd } from "@/lib/map/route";
import {
  ATTRIBUTION,
  BASEMAP_LABEL,
  emptyFc,
  FLOOR_SOURCE,
  GRATICULE_SOURCE,
  LAYER_GROUPS,
  OVERLAY_SOURCES,
  adaptProtomapsLayers,
  floorLayers,
  localStyle,
  offlineStyle,
  overlayLayers,
  overlaySources,
  tokenFlavor,
  type BasemapKind,
  type OverlayGroup,
} from "@/lib/map/style";
import { readMapTheme } from "@/lib/map/theme";
import { cn } from "@/lib/utils";

import { AircraftMarker } from "./AircraftMarker";
import { AirportCard } from "./AirportCard";

export interface OpsMapAircraft {
  lat: number;
  lon: number;
  hdgTrueDeg: number | null;
}

/** P5 part 2: an owned FBO or an active demand event, drawn as an HTML marker. */
export interface OpsMapPin {
  id: string;
  kind: "fbo" | "event";
  lat: number;
  lon: number;
  /** Short text on the pin (ICAO, or ICAO + event). */
  label: string;
  /** Hover text. */
  title: string;
}

const PIN_CLASS: Record<OpsMapPin["kind"], string> = {
  fbo: "panel flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-[0.1em] text-success",
  event:
    "panel flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-[0.1em] text-warning",
};

export interface OpsMapProps {
  /** Page is served by the local connector (null until known on the client). */
  servedByConnector: boolean | null;
  /** User allows the online basemap (null until read from storage). */
  onlineAllowed: boolean | null;
  aircraft: OpsMapAircraft | null;
  stale?: boolean;
  route: LonLat[] | null;
  origin: RouteEnd | null;
  destination: RouteEnd | null;
  trail: LonLat[];
  airports: AirportIndex | null;
  layers: Record<OverlayGroup, boolean>;
  /** P5 part 2: FBO and demand-event pins, and whether they are shown. */
  pins?: readonly OpsMapPin[];
  showPins?: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Screen area covered by overlay panels; the camera centres in the rest. */
  padding?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

type MapLibre = typeof import("maplibre-gl");

interface MarkerEls {
  aircraft: HTMLDivElement;
  origin: HTMLDivElement;
  destination: HTMLDivElement;
  popup: HTMLDivElement;
}

const FOLLOW_ZOOM = 5.5;

function lineFeature(coords: LonLat[] | null): FeatureCollection<Geometry> {
  if (!coords || coords.length < 2) return emptyFc();
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
    ],
  };
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

async function loadFloor(): Promise<FeatureCollection<Geometry>> {
  const [{ feature }, atlas] = await Promise.all([
    import("topojson-client"),
    import("world-atlas/countries-110m.json"),
  ]);
  const topology = atlas.default as Parameters<typeof feature>[0];
  const countries = topology.objects["countries"];
  if (!countries) return emptyFc();
  return feature(topology, countries) as unknown as FeatureCollection<Geometry>;
}

/** Insert layers above the style's background layer (or at the bottom). */
function addLayersAtBottom(map: MapLibreMap, layers: LayerSpecification[]) {
  const styleLayers = map.getStyle().layers;
  const firstNonBackground = styleLayers.find((l) => l.type !== "background")?.id;
  for (const layer of layers) map.addLayer(layer, firstNonBackground);
}

export function OpsMap(props: OpsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibre | null>(null);
  const markers = useRef<{ aircraft?: Marker; origin?: Marker; destination?: Marker }>({});
  const popupRef = useRef<Popup | null>(null);
  const pinMarkers = useRef(new Map<string, Marker>());
  const followChange = useRef(props.onFollowChange);
  followChange.current = props.onFollowChange;
  const airportsRef = useRef(props.airports);
  airportsRef.current = props.airports;
  const fittedRoute = useRef(false);
  const centeredOnAircraft = useRef(false);

  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [els, setEls] = useState<MarkerEls | null>(null);
  const [selected, setSelected] = useState<Airport | null>(null);

  const { servedByConnector, onlineAllowed } = props;

  // Create the map once both inputs are known on the client.
  useEffect(() => {
    if (servedByConnector === null || onlineAllowed === null) return;
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    let protocolAdded = false;
    const pinLayer = pinMarkers.current;

    (async () => {
      const [lib, worker, , floor] = await Promise.all([
        import("maplibre-gl"),
        // The worker is a separate self-contained module; point MapLibre at the bundled copy.
        import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
        import("maplibre-gl/dist/maplibre-gl.css"),
        loadFloor(),
      ]);
      if (cancelled) return;
      const maplibregl = (lib as MapLibre & { default?: MapLibre }).default ?? lib;
      maplibregl.setWorkerUrl(worker.default);
      libRef.current = maplibregl;
      const origin = window.location.origin;
      const theme = readMapTheme();
      const choice = await chooseBasemap({
        servedByConnector,
        onlineAllowed,
        fetch: window.fetch.bind(window),
        origin,
      });
      if (cancelled) return;

      let style: StyleSpecification | string;
      if (choice.kind === "local") {
        const [{ Protocol }, basemaps] = await Promise.all([
          import("pmtiles"),
          import("@protomaps/basemaps"),
        ]);
        if (cancelled) return;
        const protocol = new Protocol();
        maplibregl.addProtocol("pmtiles", protocol.tile);
        protocolAdded = true;
        const flavor = tokenFlavor(basemaps.namedFlavor("dark"), theme);
        const layers = adaptProtomapsLayers(
          basemaps.layers("protomaps", flavor, { lang: "en" }) as LayerSpecification[],
        );
        style = localStyle(origin, layers);
      } else if (choice.kind === "online") {
        style = choice.style as unknown as StyleSpecification;
      } else {
        style = offlineStyle(theme, origin);
      }

      try {
        map = new maplibregl.Map({
          container,
          style,
          center: [-30, 30],
          zoom: 1.6,
          minZoom: 1,
          maxZoom: 14,
          attributionControl: { compact: false },
          dragRotate: false,
          pitchWithRotate: false,
          fadeDuration: 0,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "WebGL is unavailable");
        return;
      }
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      // Tile/style errors (e.g. offline) are expected; the floor keeps the map useful.
      map.on("error", (ev) => {
        if (import.meta.env.DEV) console.warn("[map]", ev.error?.message ?? ev);
      });
      map.on("dragstart", (ev) => {
        if ((ev as { originalEvent?: unknown }).originalEvent) followChange.current(false);
      });

      map.on("load", () => {
        if (cancelled || !map) return;
        map.addSource(FLOOR_SOURCE, {
          type: "geojson",
          data: floor,
          attribution: ATTRIBUTION.naturalEarth,
        });
        map.addSource(GRATICULE_SOURCE, {
          type: "geojson",
          data: { type: "MultiLineString", coordinates: graticuleLines(15) },
        });
        addLayersAtBottom(map, floorLayers(theme));
        for (const [id, source] of Object.entries(overlaySources())) map.addSource(id, source);
        for (const layer of overlayLayers(theme)) {
          if (layer.type === "symbol" && choice.kind === "online") {
            // The online style brings its own glyph server; use a font it serves.
            map.addLayer({
              ...layer,
              layout: { ...layer.layout, "text-font": ["Noto Sans Regular"] },
            });
          } else map.addLayer(layer);
        }

        const onAirportClick = (ev: MapLayerMouseEvent) => {
          const ident = ev.features?.[0]?.properties?.["ident"];
          if (typeof ident !== "string") return;
          const airport = airportsRef.current?.byIdent.get(ident) ?? null;
          setSelected(airport);
          if (airport && popupRef.current && map) {
            popupRef.current.setLngLat([airport.lon, airport.lat]).addTo(map);
          }
        };
        map.on("click", "ops-airports-dot", onAirportClick);
        map.on("mouseenter", "ops-airports-dot", () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "ops-airports-dot", () => {
          if (map) map.getCanvas().style.cursor = "";
        });

        const make = () => document.createElement("div");
        const created: MarkerEls = {
          aircraft: make(),
          origin: make(),
          destination: make(),
          popup: make(),
        };
        popupRef.current = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: "18rem",
          offset: 12,
          className: "ops-popup",
        }).setDOMContent(created.popup);
        popupRef.current.on("close", () => setSelected(null));
        setEls(created);
        setBasemap(choice.kind);
        setReady(true);
      });
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "The map failed to load");
    });

    return () => {
      cancelled = true;
      for (const m of Object.values(markers.current)) m?.remove();
      markers.current = {};
      for (const m of pinLayer.values()) m.remove();
      pinLayer.clear();
      popupRef.current?.remove();
      popupRef.current = null;
      map?.remove();
      mapRef.current = null;
      if (protocolAdded) libRef.current?.removeProtocol("pmtiles");
      setReady(false);
      setEls(null);
    };
  }, [servedByConnector, onlineAllowed]);

  // Airports data (once loaded).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.airports) return;
    (map.getSource(OVERLAY_SOURCES.airports) as GeoJSONSource | undefined)?.setData(
      airportsGeoJson(props.airports.list),
    );
  }, [ready, props.airports]);

  // Route and trail lines.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource(OVERLAY_SOURCES.route) as GeoJSONSource | undefined)?.setData(
      lineFeature(props.route),
    );
  }, [ready, props.route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource(OVERLAY_SOURCES.trail) as GeoJSONSource | undefined)?.setData(
      lineFeature(props.trail),
    );
  }, [ready, props.trail]);

  // Layer toggles.
  const { airports: showAirports, trail: showTrail, route: showRoute } = props.layers;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const visible: Record<OverlayGroup, boolean> = {
      airports: showAirports,
      trail: showTrail,
      route: showRoute,
    };
    for (const group of Object.keys(LAYER_GROUPS) as OverlayGroup[]) {
      for (const id of LAYER_GROUPS[group]) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visible[group] ? "visible" : "none");
        }
      }
    }
    for (const key of ["origin", "destination"] as const) {
      const el = markers.current[key]?.getElement();
      if (el) el.style.display = showRoute ? "" : "none";
    }
  }, [ready, showAirports, showTrail, showRoute]);

  // Aircraft marker (only with real position data).
  const lat = props.aircraft?.lat;
  const lon = props.aircraft?.lon;
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib || !els) return;
    if (lat === undefined || lon === undefined) {
      markers.current.aircraft?.remove();
      delete markers.current.aircraft;
      return;
    }
    if (!markers.current.aircraft) {
      markers.current.aircraft = new lib.Marker({ element: els.aircraft })
        .setLngLat([lon, lat])
        .addTo(map);
    } else markers.current.aircraft.setLngLat([lon, lat]);
  }, [ready, els, lat, lon]);

  // Origin / destination markers.
  const o = props.origin;
  const d = props.destination;
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib || !els) return;
    const place = (key: "origin" | "destination", end: RouteEnd | null) => {
      if (!end) {
        markers.current[key]?.remove();
        delete markers.current[key];
        return;
      }
      const existing = markers.current[key];
      if (existing) existing.setLngLat([end.lon, end.lat]);
      else {
        markers.current[key] = new lib.Marker({ element: els[key], anchor: "center" })
          .setLngLat([end.lon, end.lat])
          .addTo(map);
      }
      const el = markers.current[key]?.getElement();
      if (el) el.style.display = showRoute ? "" : "none";
    };
    place("origin", o);
    place("destination", d);
  }, [ready, els, o, d, showRoute]);

  // FBO and demand-event pins (HTML markers; token classes only).
  const pins = props.pins;
  const showPins = props.showPins ?? true;
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const wanted = new Map((showPins ? (pins ?? []) : []).map((p) => [p.id, p]));
    for (const [id, marker] of pinMarkers.current) {
      if (!wanted.has(id)) {
        marker.remove();
        pinMarkers.current.delete(id);
      }
    }
    for (const pin of wanted.values()) {
      const existing = pinMarkers.current.get(pin.id);
      if (existing) {
        existing.setLngLat([pin.lon, pin.lat]);
        existing.getElement().title = pin.title;
        continue;
      }
      const el = document.createElement("div");
      el.className = PIN_CLASS[pin.kind];
      el.title = pin.title;
      el.dataset["testid"] = pin.kind === "fbo" ? "map-fbo-pin" : "map-event-pin";
      const dot = document.createElement("span");
      dot.className = "status-dot size-1.5";
      dot.setAttribute("aria-hidden", "true");
      el.append(dot, document.createTextNode(pin.label));
      pinMarkers.current.set(
        pin.id,
        new lib.Marker({ element: el, anchor: "bottom", offset: [0, -6] })
          .setLngLat([pin.lon, pin.lat])
          .addTo(map),
      );
    }
  }, [ready, pins, showPins]);

  // Keep the followed aircraft clear of the overlay panels.
  const pad = props.padding;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !pad) return;
    map.setPadding(pad);
  }, [ready, pad]);

  // Camera: follow the aircraft, or frame the route once when there is no aircraft.
  const follow = props.follow;
  const route = props.route;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (lat !== undefined && lon !== undefined) {
      if (!follow) return;
      const reduce = prefersReducedMotion();
      if (!centeredOnAircraft.current) {
        centeredOnAircraft.current = true;
        map.jumpTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), FOLLOW_ZOOM) });
      } else if (reduce) map.jumpTo({ center: [lon, lat] });
      else map.easeTo({ center: [lon, lat], duration: 900, easing: (t) => t });
      return;
    }
    centeredOnAircraft.current = false;
    if (route && route.length > 1 && !fittedRoute.current && libRef.current) {
      fittedRoute.current = true;
      const bounds = new libRef.current.LngLatBounds();
      for (const p of route) bounds.extend(p);
      map.fitBounds(bounds, { padding: 80, animate: !prefersReducedMotion(), maxZoom: 8 });
    }
  }, [ready, lat, lon, follow, route]);

  const hdg = props.aircraft?.hdgTrueDeg ?? null;

  return (
    <div className={cn("ops-map relative h-full w-full overflow-hidden", props.className)}>
      <div
        ref={containerRef}
        // MapLibre's stylesheet makes its container position: relative, so size it explicitly.
        className="h-full w-full"
        data-testid="ops-map"
        data-ready={ready ? "true" : "false"}
        data-basemap={basemap ?? undefined}
      />
      {!ready && !error ? (
        <div aria-hidden="true" className="bg-radar pointer-events-none absolute inset-0" />
      ) : null}
      {error ? (
        <div className="absolute inset-0 grid place-items-center p-6" role="alert">
          <p className="panel-inset max-w-sm px-5 py-4 text-center text-sm text-muted-foreground">
            The map could not start: {error}
          </p>
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 md:bottom-4 md:left-4">
        <span
          className="panel inline-flex items-center gap-2 px-2.5 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
          data-testid="basemap-badge"
          data-basemap={basemap ?? "loading"}
        >
          <span
            aria-hidden="true"
            className={cn(
              "status-dot size-1.5",
              basemap === "local"
                ? "text-success"
                : basemap === "online"
                  ? "text-accent"
                  : "text-warning",
            )}
          />
          {basemap ? BASEMAP_LABEL[basemap] : "Loading map"}
        </span>
      </div>
      {els && props.aircraft
        ? createPortal(
            <AircraftMarker headingDeg={hdg} stale={props.stale ?? false} />,
            els.aircraft,
          )
        : null}
      {els && o ? createPortal(<EndpointMarker ident={o.ident} kind="origin" />, els.origin) : null}
      {els && d
        ? createPortal(<EndpointMarker ident={d.ident} kind="destination" />, els.destination)
        : null}
      {els && selected ? createPortal(<AirportCard airport={selected} />, els.popup) : null}
    </div>
  );
}

function EndpointMarker({ ident, kind }: { ident: string; kind: "origin" | "destination" }) {
  return (
    <div className="relative flex flex-col items-center" data-testid={`map-${kind}`}>
      <span
        aria-hidden="true"
        className={cn(
          "status-dot size-3",
          kind === "origin" ? "text-primary" : "text-accent status-dot-live",
        )}
      />
      <span className="panel absolute top-4 whitespace-nowrap px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-[0.12em] text-foreground">
        {ident}
      </span>
    </div>
  );
}
