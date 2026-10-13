import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const inputClass =
  "w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";
const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
export const primaryButton = `${buttonBase} bg-gradient-brand text-primary-foreground shadow-glow`;
export const secondaryButton = `${buttonBase} border border-border bg-secondary text-foreground hover:bg-secondary/70`;

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="label-eyebrow">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One "label — value" row in a settings list. */
export function SettingRow({
  label,
  children,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
      data-testid={testId}
    >
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 break-all font-mono text-sm text-foreground">
        {children}
      </dd>
    </div>
  );
}

/** Inline result line after an action; announced politely. */
export function Note({ note }: { note: { tone: "ok" | "error"; text: string } | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "min-h-5 text-xs",
        note?.tone === "error" ? "text-destructive" : "text-success",
      )}
    >
      {note?.text ?? ""}
    </p>
  );
}

/** Two- or three-way choice rendered as a radio group of pills. */
export function Segmented<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <legend className="sr-only">{label}</legend>
      <span className="text-sm text-muted-foreground" aria-hidden="true">
        {label}
      </span>
      <div className="flex rounded-lg border border-border bg-secondary/60 p-0.5">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                "cursor-pointer rounded-md px-3 py-1 font-mono text-xs transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
                checked
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
