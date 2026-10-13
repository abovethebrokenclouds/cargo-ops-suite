// Placeholder data until the MSFS 2024 SimConnect bridge is wired up.
export type Aircraft = { reg: string; type: string; base: string; status: "Ready" | "En route" | "Maintenance"; payloadKg: number };
export type CargoJob = { id: string; from: string; to: string; cargo: string; weightKg: number; payout: number; deadline: string };

export const company = { name: "Cargo Ops Logistics", cash: 248_500, reputation: 4.6, hub: "KMEM" };

export const fleet: Aircraft[] = [
  { reg: "N401CO", type: "Cessna 208B Grand Caravan", base: "KMEM", status: "Ready", payloadKg: 1_360 },
  { reg: "N402CO", type: "ATR 72-600F", base: "KMEM", status: "En route", payloadKg: 8_900 },
  { reg: "N403CO", type: "Boeing 747-8F", base: "KLAX", status: "Maintenance", payloadKg: 137_000 },
];

export const jobs: CargoJob[] = [
  { id: "J-1042", from: "KMEM", to: "KATL", cargo: "Medical supplies", weightKg: 950, payout: 6_400, deadline: "6h" },
  { id: "J-1043", from: "KMEM", to: "KORD", cargo: "Auto parts", weightKg: 7_200, payout: 18_900, deadline: "12h" },
  { id: "J-1044", from: "KLAX", to: "RJAA", cargo: "Electronics", weightKg: 96_000, payout: 212_000, deadline: "24h" },
];
