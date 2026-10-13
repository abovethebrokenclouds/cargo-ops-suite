import { render, screen } from "@testing-library/react";
import { Map as MapIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title, eyebrow, description and action", () => {
    render(
      <EmptyState
        icon={MapIcon}
        eyebrow="Phase P2"
        title="Map arrives in P2"
        description="Vector basemap and live aircraft track."
        action={<button type="button">Open settings</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Map arrives in P2" })).toBeInTheDocument();
    expect(screen.getByText("Phase P2")).toHaveClass("label-eyebrow");
    expect(screen.getByText("Vector basemap and live aircraft track.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
  });
});
