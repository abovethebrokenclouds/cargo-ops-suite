import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { CompactPanel } from "@/components/panel/CompactPanel";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { routeView } from "@/lib/flight/flight-view";
import { announcePanelReady } from "@/lib/framing";
import { useUnits } from "@/lib/settings/units";
import { useNow } from "@/lib/sim-state/hooks";
import { useSimConnection } from "@/lib/transport/useSimConnection";
import { useMetar } from "@/lib/weather/use-metar";

// Compact read-only page for the in-sim toolbar panel (msfs-panel/ loads it in an iframe).
// The root layout renders it without navigation; the connector lets only this path be framed.

export const Route = createFileRoute("/panel")({
  head: () => ({
    meta: [
      { title: "Cargo Ops panel" },
      {
        name: "description",
        content: "Compact Cargo Ops status for the simulator's toolbar panel.",
      },
    ],
  }),
  component: PanelPage,
});

function PanelPage() {
  const { state, pairingRequired } = useSimConnection();
  const now = useNow(1000);
  const [units] = useUnits();
  // The airport list only feeds the demo company (useCompanyView ignores it otherwise).
  const lookup = useAirportLookup();
  const view = useCompanyView(state, lookup);
  const route = routeView(state);
  const mission = state.sim.mission ?? null;
  const metar = useMetar([
    route.origin ?? mission?.origin ?? null,
    route.destination ?? mission?.destination ?? null,
  ]);

  useEffect(() => {
    announcePanelReady(window);
  }, []);

  return (
    <CompactPanel
      state={state}
      now={now}
      units={units}
      fleet={view.fleet}
      fleetSource={view.fleet ? view.source : null}
      metar={metar}
      pairingRequired={pairingRequired ?? false}
    />
  );
}
