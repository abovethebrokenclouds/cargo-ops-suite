import { createFileRoute } from "@tanstack/react-router";

import { PageHero } from "@/components/AppNav";
import { LiveFlightView } from "@/components/flight/LiveFlightView";
import { routeView } from "@/lib/flight/flight-view";
import type { ClientSimState } from "@/lib/sim-state";
import { useSimConnection } from "@/lib/transport/useSimConnection";

export const Route = createFileRoute("/flight")({
  head: () => ({
    meta: [
      { title: "Live Flight — Cargo Ops" },
      {
        name: "description",
        content: "Live altitude, speeds, heading, vertical speed, fuel and progress from MSFS.",
      },
      { property: "og:title", content: "Live Flight — Cargo Ops" },
      {
        property: "og:description",
        content: "Live altitude, speeds, heading, vertical speed, fuel and progress from MSFS.",
      },
    ],
  }),
  component: Flight,
});

function heroSub(state: ClientSimState): string {
  switch (state.connection) {
    case "demo":
      return "Replaying the built-in demo flight. Every value is tagged DEMO; run the local connector for your own simulator.";
    case "replay":
      return "Replaying a recorded flight from the connector. Values are tagged REPLAY.";
    case "live": {
      const name = state.sim.sim?.name ?? state.welcome?.sim.name;
      return state.welcome?.sim.connected || state.sim.sim?.connected
        ? `Live from ${name ?? "the simulator"}: altitude, speeds, fuel and progress as you fly.`
        : "Connector online. Start the simulator to stream telemetry.";
    }
    default:
      return "Altitude, speeds, fuel and progress straight from the simulator. Waiting for a connection.";
  }
}

function Flight() {
  const { state } = useSimConnection();
  const route = routeView(state);
  const title =
    route.origin && route.destination ? `${route.origin} → ${route.destination}` : "In the air.";
  return (
    <>
      <PageHero eyebrow="Live flight" title={title} sub={heroSub(state)} />
      <LiveFlightView />
    </>
  );
}
