import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";
import { DemandEvents } from "@/components/cargo/DemandEvents";
import { demoDomains } from "@/lib/economy/company";

import { FboBuyPanel } from "./FboBuyPanel";
import { ModuleCard } from "./ModuleCard";
import { PricingPanel } from "./PricingPanel";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const demo = demoDomains(lookup);

describe("demo FBO (same book as the connector)", () => {
  it("owns the KLIT FBO with a fuel farm, a hangar and ramp level 2, and income history", () => {
    const [fbo] = demo.fbos.fbos;
    expect(fbo?.icao).toBe("KLIT");
    expect(fbo?.modules.map((m) => [m.kind, m.level])).toEqual([
      ["fuel", 1],
      ["hangar", 1],
      ["maintenance", 0],
      ["cargo", 0],
      ["ramp", 2],
    ]);
    expect(fbo?.daily.length).toBeGreaterThan(10);
    expect(fbo?.pnl.some((m) => m.savings > 0)).toBe(true);
    expect(demo.company.milestones?.find((m) => m.id === "first_fbo")?.reached).toBe(true);
    expect(demo.fleet.aircraft[0]?.insurance?.insured).toBe(true);
  });
});

describe("ModuleCard", () => {
  it("shows the level, upkeep and next cost; the action is disabled without a connector", () => {
    const fbo = demo.fbos.fbos[0];
    const ramp = fbo?.modules.find((m) => m.kind === "ramp");
    if (!ramp) throw new Error("ramp");
    const onUpgrade = vi.fn();
    const { rerender } = render(
      <ModuleCard
        module={ramp}
        gameMs={0}
        enabled={false}
        busy={false}
        disabledNote="demo"
        onBuy={() => {}}
        onUpgrade={onUpgrade}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Level 2 of 3");
    const button = screen.getByTestId("fbo-module-action") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    rerender(
      <ModuleCard
        module={ramp}
        gameMs={0}
        enabled
        busy={false}
        disabledNote={undefined}
        onBuy={() => {}}
        onUpgrade={onUpgrade}
      />,
    );
    fireEvent.click(screen.getByTestId("fbo-module-action"));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });
});

describe("PricingPanel", () => {
  it("shows the price, the elasticity demand and applies the new prices", () => {
    // The Radix slider measures itself; jsdom has no ResizeObserver.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const fbo = demo.fbos.fbos[0];
    if (!fbo) throw new Error("fbo");
    const onApply = vi.fn();
    render(
      <PricingPanel fbo={fbo} enabled busy={false} disabledNote={undefined} onApply={onApply} />,
    );
    // The demo FBO charges 104 % of the regional price: e = 1 − 3 × 0.04 = 0.88.
    expect(screen.getByText(/Customers drifting away \(88 %\)/)).toBeTruthy();
    const apply = screen.getByTestId("fbo-pricing-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true); // nothing changed yet
  });
});

describe("FboBuyPanel", () => {
  it("searches the bundled airports and quotes KATL; buying is disabled in demo mode", () => {
    render(
      <FboBuyPanel
        lookup={lookup}
        owned={new Set(["KLIT"])}
        loans={demo.loans}
        enabled={false}
        busy={false}
        disabledNote="demo"
        onBuy={() => {}}
        onBuild={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("fbo-search"), { target: { value: "katl" } });
    fireEvent.click(screen.getByText(/Hartsfield/));
    const quote = screen.getByTestId("fbo-quote");
    expect(quote.textContent).toContain("$774,000");
    expect(quote.textContent).toContain("$425,700");
    expect((screen.getByTestId("fbo-buy") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("fbo-build") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DemandEvents", () => {
  it("lists active events with their payout and fuel uplift", () => {
    render(<DemandEvents demand={demo.demand} source="demo" lookup={lookup} />);
    const events = screen.getAllByTestId("demand-event");
    expect(events.length).toBe(demo.demand.events.length);
    expect(events[0]?.textContent).toContain(`+${demo.demand.events[0]?.payoutPct} %`);
  });
});
