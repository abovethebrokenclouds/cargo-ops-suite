import { useEffect, useState } from "react";

import type { FboState } from "@cargo-ops/protocol";
import { FUEL_RATIO_RANGE, HANDLING_RANGE, elasticity } from "@cargo-ops/economy";
import { secondaryButton } from "@/components/company/styles";
import { Slider } from "@/components/ui/slider";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Demand at a price ratio as a word and a tone (the elasticity curve). */
function demandLabel(e: number): { text: string; tone: string } {
  if (e >= 1.15) return { text: "Busy", tone: "text-success" };
  if (e >= 0.9) return { text: "Normal", tone: "text-foreground" };
  if (e >= 0.5) return { text: "Customers drifting away", tone: "text-warning" };
  return { text: "Most customers lost", tone: "text-destructive" };
}

/** Fuel price (× the regional price) and handling fee sliders with the demand they cause. */
export function PricingPanel({
  fbo,
  enabled,
  busy,
  disabledNote,
  onApply,
}: {
  fbo: FboState;
  enabled: boolean;
  busy: boolean;
  disabledNote: string | undefined;
  onApply: (p: { fuelPriceRatio: number; handlingFeeUsd: number }) => void;
}) {
  const [ratio, setRatio] = useState(fbo.pricing.fuelPriceRatio);
  const [fee, setFee] = useState(fbo.pricing.handlingFeeUsd);
  useEffect(() => {
    setRatio(fbo.pricing.fuelPriceRatio);
    setFee(fbo.pricing.handlingFeeUsd);
  }, [fbo.id, fbo.pricing.fuelPriceRatio, fbo.pricing.handlingFeeUsd]);
  const hasFarm = fbo.modules.some((m) => m.kind === "fuel" && m.level > 0);
  const eFuel = elasticity(ratio);
  const eHandling = elasticity(fee / fbo.pricing.referenceHandlingUsd);
  const fuel = demandLabel(eFuel);
  const handling = demandLabel(eHandling);
  const changed =
    Math.abs(ratio - fbo.pricing.fuelPriceRatio) > 1e-6 ||
    Math.abs(fee - fbo.pricing.handlingFeeUsd) > 1e-6;
  return (
    <div className="flex flex-col gap-5" data-testid="fbo-pricing">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <label htmlFor="fbo-fuel-price" className="font-medium text-foreground">
            Fuel price
          </label>
          <span className="font-mono text-foreground font-tabular">
            ${(fbo.pricing.regionalUsdPerKg * ratio).toFixed(3)}/kg · {Math.round(ratio * 100)} %
          </span>
        </div>
        <Slider
          id="fbo-fuel-price"
          aria-label="Fuel price, percent of the regional price"
          min={FUEL_RATIO_RANGE.min}
          max={FUEL_RATIO_RANGE.max}
          step={0.01}
          value={[ratio]}
          disabled={!enabled || busy || !hasFarm}
          onValueChange={(v) => setRatio(v[0] ?? ratio)}
        />
        <p className="flex justify-between gap-3 font-mono text-[0.6875rem] text-muted-foreground">
          <span>
            Regional ${fbo.pricing.regionalUsdPerKg.toFixed(3)} · cost $
            {fbo.pricing.costUsdPerKg.toFixed(3)}
          </span>
          <span className={fuel.tone}>
            {hasFarm ? `${fuel.text} (${Math.round(eFuel * 100)} %)` : "No fuel farm"}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <label htmlFor="fbo-handling" className="font-medium text-foreground">
            Handling fee
          </label>
          <span className="font-mono text-foreground font-tabular">
            {formatUsd(fee)} / turboprop
          </span>
        </div>
        <Slider
          id="fbo-handling"
          aria-label="Handling fee in dollars"
          min={HANDLING_RANGE.min}
          max={HANDLING_RANGE.max}
          step={5}
          value={[fee]}
          disabled={!enabled || busy}
          onValueChange={(v) => setFee(v[0] ?? fee)}
        />
        <p className="flex justify-between gap-3 font-mono text-[0.6875rem] text-muted-foreground">
          <span>Reference {formatUsd(fbo.pricing.referenceHandlingUsd)} · jets pay × 3</span>
          <span className={handling.tone}>
            {handling.text} ({Math.round(eHandling * 100)} %)
          </span>
        </p>
      </div>
      <button
        type="button"
        className={cn(secondaryButton, "self-start")}
        disabled={!enabled || busy || !changed}
        title={disabledNote}
        onClick={() => onApply({ fuelPriceRatio: ratio, handlingFeeUsd: fee })}
        data-testid="fbo-pricing-apply"
      >
        Apply prices
      </button>
    </div>
  );
}
