import { createFileRoute } from "@tanstack/react-router";

import { MapView } from "@/components/map/MapView";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Ops Map — Cargo Ops" },
      {
        name: "description",
        content: "Aircraft position, route, trail and nearby airports on a self-hosted map.",
      },
      { property: "og:title", content: "Ops Map — Cargo Ops" },
      {
        property: "og:description",
        content: "Aircraft position, route, trail and nearby airports on a self-hosted map.",
      },
    ],
  }),
  component: MapView,
});
