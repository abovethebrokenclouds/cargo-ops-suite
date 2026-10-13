// Test helper: the bundled OurAirports subset (public domain), read from the repository.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EconomyAirport } from "../src/airports";

let cache: EconomyAirport[] | null = null;

export function bundledAirports(): EconomyAirport[] {
  cache ??= JSON.parse(
    readFileSync(resolve(__dirname, "../../../src/assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[];
  return cache;
}
