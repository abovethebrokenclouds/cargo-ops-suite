import { useState } from "react";

import { parseEnteredPayload } from "@/lib/economy/payload-check";
import { cn } from "@/lib/utils";
import { PlayerTag } from "./PayloadCheck";

// Payload entered by you (docs/ECONOMY.md "Payload entered by you"): a number the player
// types for the loaded mission when the simulator's payload stations are missing or wrong.
// It is labelled as the player's, only stands in for an `unknown` station readout and can
// never override a sim reading or earn a bonus. Sent with `mission.payload {kg | null}`.

const inputClass =
  "w-32 rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-50";

export function EnteredPayload({
  valueKg,
  cargoKg,
  busy,
  editable,
  onSave,
  className,
}: {
  /** The value stored on the mission; null/undefined = none. */
  valueKg: number | null | undefined;
  cargoKg: number;
  busy: boolean;
  /** False once the mission departed (the check is frozen). */
  editable: boolean;
  onSave: (kg: number | null) => void;
  className?: string;
}) {
  const stored = valueKg ?? null;
  const [text, setText] = useState(stored === null ? "" : String(stored));
  const [shown, setShown] = useState(stored);
  if (shown !== stored) {
    setShown(stored);
    setText(stored === null ? "" : String(stored));
  }
  const parsed = parseEnteredPayload(text);
  const invalid = parsed !== null && Number.isNaN(parsed);
  return (
    <form
      className={cn(
        "panel-inset flex flex-wrap items-end gap-3 px-5 py-4 text-sm text-muted-foreground",
        className,
      )}
      data-testid="entered-payload"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!invalid && editable) onSave(parsed);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="entered-payload" className="label-eyebrow flex items-center gap-2">
          Payload entered by you (kg) <PlayerTag />
        </label>
        <input
          id="entered-payload"
          inputMode="decimal"
          className={inputClass}
          placeholder="none"
          value={text}
          disabled={!editable}
          aria-invalid={invalid || undefined}
          onChange={(ev) => setText(ev.target.value)}
        />
      </div>
      <button type="submit" className={buttonClass} disabled={busy || invalid || !editable}>
        Save
      </button>
      {stored !== null && editable ? (
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onSave(null)}>
          Clear
        </button>
      ) : null}
      <p className="min-w-[16rem] flex-1 text-xs">
        {editable
          ? `For aircraft whose payload stations the sim does not report: the cargo you loaded (${Math.round(cargoKg)} kg required), crew excluded. Used only when the sim reports no stations, never over a sim reading, and it earns no bonus.`
          : "Frozen at departure with the payload check."}
      </p>
    </form>
  );
}
