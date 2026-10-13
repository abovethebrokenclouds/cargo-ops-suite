// Shared token-only class strings for the company and fleet screens.

export const inputClass =
  "w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
export const primaryButton = `${buttonBase} bg-gradient-brand text-primary-foreground shadow-glow`;
export const secondaryButton = `${buttonBase} border border-border bg-secondary text-foreground hover:bg-secondary/70`;
export const ghostButton =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";
export const dialogClass =
  "panel-elevated max-h-[90vh] overflow-y-auto border-border bg-card text-foreground sm:max-w-lg";
