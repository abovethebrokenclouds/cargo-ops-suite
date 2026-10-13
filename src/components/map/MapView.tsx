import { Crosshair, MapPin, Plane, Route as RouteIcon, Warehouse, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/EmptyState";
import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { isSessionUp, isStale, routeView } from "@/lib/flight/flight-view";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { EMPTY, formatDegrees, formatInt, formatMinutes } from "@/lib/format";
import { loadAirports, nearbyAirports, type AirportIndex } from "@/lib/map/airports";
import { greatCirclePoints, haversineNm } from "@/lib/map/geo";
import { routeEnds, type RouteEnd } from "@/lib/map/route";
import type { OverlayGroup } from "@/lib/map/style";
import { useTrail } from "@/lib/map/useTrail";
import { useOnlineMapsSetting } from "@/lib/settings/map-settings";
import type { ClientSimState } from "@/lib/sim-state";
import { useNow } from "@/lib/sim-state/hooks";
import { useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

import { OpsMap, type OpsMapPin } from "./OpsMap";

const NEARBY_RADIUS_NM = 50;

/** Bottom edge of the sticky app header, so the map fills exactly the rest of the viewport. */
function useHeaderBottom(): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const update = () => setBottom(Math.round(header.getBoundingClientRect().height));
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(header);
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return bottom;
}

/** Keep the previous value while `equal` says nothing meaningful changed. */
function useStable<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (!equal(ref.current, value)) ref.current = value;
  return ref.current;
}

function sameEnd(a: RouteEnd | null, b: RouteEnd | null): boolean {
  if (!a || !b) return a === b;
  return a.ident === b.ident && a.lat === b.lat && a.lon === b.lon;
}

type Padding = { top: number; right: number; bottom: number; left: number };

/**
 * Camera padding for the flight panel: below it on narrow screens (panel across the top),
 * beside it on wide screens (panel on the left).
 */
function usePanelPadding(panel: HTMLElement | null): Padding | undefined {
  const [padding, setPadding] = useState<Padding | undefined>(undefined);
  useEffect(() => {
    if (!panel) return;
    const update = () => {
      const wide = window.innerWidth >= 768;
      const next = wide
        ? { top: 0, right: 0, bottom: 0, left: Math.round(panel.offsetWidth + 16) }
        : { top: Math.round(panel.offsetHeight + 12), right: 0, bottom: 0, left: 0 };
      setPadding((prev) =>
        prev && prev.top === next.top && prev.left === next.left ? prev : next,
      );
    };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(panel);
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [panel]);
  return padding;
}

function waitingCopy(state: ClientSimState): string {
  switch (state.connection) {
    case "live":
      return "Connector online. Position appears as soon as the simulator streams telemetry.";
    case "demo":
    case "replay":
      return "The replay has not sent a position yet.";
    case "disconnected":
    case "error":
      return "The connector is offline. The map shows the last session only after it reconnects.";
    default:
      return "Connecting to the data source.";
  }
}

export function MapView() {
  const { state, transportKind } = useSimConnection();
  const now = useNow(1000);
  const [onlineAllowed] = useOnlineMapsSetting();
  const [airports, setAirports] = useState<AirportIndex | null>(null);
  const [follow, setFollow] = useState(true);
  const [layers, setLayers] = useState<Record<OverlayGroup, boolean>>({
    airports: true,
    trail: true,
    route: true,
  });
  const headerBottom = useHeaderBottom();
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const padding = usePanelPadding(panel);
  const trail = useTrail(state);
  // P5 part 2: owned FBOs and active demand events as pins.
  const lookup = useAirportLookup();
  const { fbos, demand } = useCompanyView(state, lookup);
  const [showPins, setShowPins] = useState(true);
  const pins = useMemo<OpsMapPin[]>(() => {
    const out: OpsMapPin[] = [];
    for (const f of fbos?.fbos ?? []) {
      out.push({
        id: `fbo-${f.id}`,
        kind: "fbo",
        lat: f.lat,
        lon: f.lon,
        label: `FBO ${f.icao}`,
        title: `Your FBO at ${f.name} (${f.status === "active" ? "operating" : "building"})`,
      });
    }
    for (const e of demand?.events ?? []) {
      const a = lookup?.get(e.icao);
      if (!a) continue;
      out.push({
        id: `event-${e.id}`,
        kind: "event",
        lat: a.lat,
        lon: a.lon,
        label: `${e.icao} ${e.label}`,
        title: `${e.label} at ${a.name}: payouts +${e.payoutPct} %, fuel +${e.fuelPct} %`,
      });
    }
    return out;
  }, [fbos, demand, lookup]);

  useEffect(() => {
    let cancelled = false;
    loadAirports()
      .then((index) => {
        if (!cancelled) setAirports(index);
      })
      .catch(() => {
        // The map still works without the airport layer.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionUp = isSessionUp(state);
  const position = sessionUp ? (state.sim.position ?? null) : null;
  const motion = sessionUp ? (state.sim.motion ?? null) : null;
  const stale = isStale(state, now);

  const ends = useMemo(() => routeEnds(state, airports), [state, airports]);
  const origin = useStable(ends.origin, sameEnd);
  const destination = useStable(ends.destination, sameEnd);
  const routeLine = useMemo(
    () => (origin && destination ? greatCirclePoints(origin, destination) : null),
    [origin, destination],
  );

  const view = routeView(state);
  const distanceNm =
    view.distanceRemainingNm ??
    (position && destination ? haversineNm(position, destination) : null);

  // Recount nearby airports only when the aircraft has moved about a nautical mile.
  const coarsePosition = useStable(position, (a, b) =>
    a && b ? Math.abs(a.lat - b.lat) < 1 / 60 && Math.abs(a.lon - b.lon) < 1 / 60 : a === b,
  );
  const nearbyCount = useMemo(
    () =>
      airports && coarsePosition
        ? nearbyAirports(airports.list, coarsePosition, NEARBY_RADIUS_NM).length
        : null,
    [airports, coarsePosition],
  );

  const aircraft = position
    ? { lat: position.lat, lon: position.lon, hdgTrueDeg: motion?.hdgTrueDeg ?? null }
    : null;

  const toggle = (key: OverlayGroup) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  return (
    <section
      aria-label="Ops map"
      className="fixed inset-x-0 bottom-0 top-[6.75rem] z-10 xl:top-[3.875rem]"
      style={headerBottom !== null ? { top: headerBottom } : undefined}
      data-testid="map-view"
    >
      <h1 className="sr-only">Ops map</h1>
      <OpsMap
        servedByConnector={transportKind === null ? null : transportKind === "live"}
        onlineAllowed={onlineAllowed}
        aircraft={aircraft}
        stale={stale}
        route={routeLine}
        origin={origin}
        destination={destination}
        trail={trail}
        airports={airports}
        layers={layers}
        pins={pins}
        showPins={showPins}
        follow={follow}
        onFollowChange={setFollow}
        {...(padding ? { padding } : {})}
      />

      {/* Flight panel */}
      <div className="pointer-events-none absolute left-3 right-16 top-3 z-20 md:left-4 md:right-auto md:top-4 md:w-[21rem]">
        <div
          ref={setPanel}
          className="@container panel-elevated pointer-events-auto flex flex-col gap-3 p-4 md:p-5"
          data-stale={stale ? "" : undefined}
          data-testid="map-flight-panel"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="label-eyebrow">Distance remaining</p>
            <div className="flex items-center gap-1.5">
              {stale ? <StaleTag /> : null}
              <SourceTag source={sessionUp ? state.source : null} />
            </div>
          </div>
          <p className="flex items-baseline gap-2" data-testid="map-distance">
            <span
              className="metric-xl metric-live metric-glow text-[clamp(2.75rem,22cqi,5.5rem)]"
              data-empty={distanceNm === null ? "" : undefined}
            >
              {distanceNm === null ? EMPTY : formatInt(distanceNm)}
            </span>
            <span className="font-display text-lg text-muted-foreground">nm</span>
          </p>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="font-mono tracking-[0.1em] text-foreground">
              {view.origin && view.destination
                ? `${view.origin} → ${view.destination}`
                : "No route"}
            </span>
            <span className="font-mono text-muted-foreground">
              ETE {view.eteMin === null ? EMPTY : formatMinutes(view.eteMin)}
            </span>
          </div>
          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3">
            <Readout label="GS" value={motion ? formatInt(motion.gsKt) : null} unit="kt" />
            <Readout label="ALT" value={position ? formatInt(position.altFt) : null} unit="ft" />
            <Readout
              label="HDG"
              value={motion ? formatDegrees(motion.hdgTrueDeg) : null}
              unit="T"
            />
          </dl>
          <p className="hidden text-xs text-muted-foreground md:block">
            {nearbyCount === null
              ? "Nearby airports appear with a position."
              : `${nearbyCount} airport${nearbyCount === 1 ? "" : "s"} within ${NEARBY_RADIUS_NM} nm`}
          </p>
        </div>
      </div>

      {/* Map controls */}
      <div
        className="absolute right-3 top-3 z-20 flex flex-col gap-2 md:right-4 md:top-4"
        role="toolbar"
        aria-label="Map controls"
      >
        <ControlButton
          label={follow ? "Following aircraft" : "Follow aircraft"}
          pressed={follow}
          onClick={() => setFollow((f) => !f)}
          testId="follow-toggle"
        >
          <Crosshair className="size-4" aria-hidden="true" />
        </ControlButton>
        <div className="panel flex flex-col gap-1 p-1" role="group" aria-label="Layers">
          <ControlButton
            label="Airports"
            pressed={layers.airports}
            onClick={() => toggle("airports")}
            plain
          >
            <MapPin className="size-4" aria-hidden="true" />
          </ControlButton>
          <ControlButton label="Trail" pressed={layers.trail} onClick={() => toggle("trail")} plain>
            <Waypoints className="size-4" aria-hidden="true" />
          </ControlButton>
          <ControlButton label="Route" pressed={layers.route} onClick={() => toggle("route")} plain>
            <RouteIcon className="size-4" aria-hidden="true" />
          </ControlButton>
          <ControlButton
            label="FBOs and demand events"
            pressed={showPins}
            onClick={() => setShowPins((v) => !v)}
            plain
            testId="pins-toggle"
          >
            <Warehouse className="size-4" aria-hidden="true" />
          </ControlButton>
        </div>
      </div>

      {!position ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6 pt-56 md:pt-6">
          <EmptyState
            className="pointer-events-auto max-w-sm bg-background/75 backdrop-blur-md"
            icon={Plane}
            eyebrow="Ops map"
            title="Waiting for position"
            description={waitingCopy(state)}
          />
        </div>
      ) : null}
    </section>
  );
}

function Readout({ label, value, unit }: { label: string; value: string | null; unit: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="label-eyebrow text-[0.5625rem]">{label}</dt>
      <dd className="flex items-baseline gap-1">
        <span
          className="metric-md metric-live text-[1.375rem]"
          data-empty={value === null ? "" : undefined}
        >
          {value ?? EMPTY}
        </span>
        <span className="font-mono text-[0.625rem] text-muted-foreground">{unit}</span>
      </dd>
    </div>
  );
}

function ControlButton({
  label,
  pressed,
  onClick,
  children,
  plain = false,
  testId,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  plain?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground",
        !plain && "panel",
        pressed && "bg-primary/15 text-accent shadow-glow",
      )}
    >
      {children}
    </button>
  );
}
