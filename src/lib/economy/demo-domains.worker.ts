// Runs the seeded DEMO company (a few simulated months of the economy) off the page's main
// thread: on a slow machine it took over a second, which froze the page right after load.
// In: the bundled airport list. Out: the DemoDomains, or an error message.

import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";

import { demoDomains } from "./demo-domains";

self.onmessage = (ev: MessageEvent<{ airports: readonly EconomyAirport[] }>) => {
  try {
    self.postMessage({ ok: true, domains: demoDomains(airportLookup(ev.data.airports)) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
