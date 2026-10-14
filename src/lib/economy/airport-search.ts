import type { AirportLookup, EconomyAirport } from "@cargo-ops/economy";

/**
 * Search the bundled airports by ICAO ident prefix, exact IATA code or name. An exact ident
 * comes first; fewer than 2 characters give nothing. Shared by the FBO buy panel and the
 * Live Flight destination picker.
 */
export function searchAirports(lookup: AirportLookup, query: string, max = 6): EconomyAirport[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const exact = lookup.get(q);
  const out: EconomyAirport[] = exact ? [exact] : [];
  for (const a of lookup.list) {
    if (out.length >= max) break;
    if (a === exact) continue;
    if (a.ident.startsWith(q) || a.iata?.toUpperCase() === q || a.name.toUpperCase().includes(q)) {
      out.push(a);
    }
  }
  return out;
}
