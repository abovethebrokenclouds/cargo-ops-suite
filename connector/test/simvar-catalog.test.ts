// Static guard: every SimConnect name the connector requests is in the checked-in
// allow-list (src/sim/simvar-catalog.ts, audited in docs/SIMVARS.md) with a unit that is
// compatible with the documented one. Future edits cannot introduce unknown names.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AI_TRAFFIC_DATUMS } from "../src/sim/ai-traffic";
import { SYSTEM_EVENTS, SYSTEM_STATES } from "../src/sim/simconnect-source";
import {
  SIMVAR_CATALOG,
  SYSTEM_EVENT_CATALOG,
  SYSTEM_STATE_CATALOG,
  UNIT_DIMENSIONS,
  catalogProblem,
} from "../src/sim/simvar-catalog";
import { MAX_ENGINES, MAX_STATIONS, SIMVARS, buildDatums } from "../src/sim/simvars";

const ALL_COUNTS = { engines: MAX_ENGINES, stations: MAX_STATIONS };

/** connector/src, from dist-test/connector/test. */
const SRC = join(__dirname, "..", "..", "..", "src");

/** A SimConnect request whose name (always the second argument) is a string literal. */
const literalCall =
  /\b(addToDataDefinition|subscribeToSystemEvent|requestSystemState)\s*\(\s*[^,()]+,\s*["'`]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("SimVar catalogue (allow-list)", () => {
  it("is internally consistent", () => {
    const names = SIMVAR_CATALOG.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, "duplicate catalogue names");
    for (const e of SIMVAR_CATALOG) {
      assert.match(e.name, /^[A-Z0-9 ]+$/, `${e.name}: base name only, upper case, no :index`);
      assert.match(e.doc, /^https:\/\/docs\.flightsimulator\.com\//, `${e.name}: doc link`);
      if (e.dimension === "string") {
        assert.equal(e.docUnit, null, `${e.name}: strings have no unit`);
      } else {
        const units: readonly string[] = UNIT_DIMENSIONS[e.dimension];
        assert.ok(
          e.docUnit !== null && units.includes(e.docUnit.toLowerCase()),
          `${e.name}: documented unit ${e.docUnit} is not a ${e.dimension} unit`,
        );
      }
    }
  });

  it("covers every SimVar in the table, every index, with a documented-compatible unit", () => {
    const seen = new Set<string>();
    for (const group of ["counts", "slow", "fast"] as const) {
      const datums = buildDatums(group, ALL_COUNTS);
      assert.ok(datums.length > 0, group);
      for (const d of datums) {
        seen.add(d.spec.key);
        const problem = catalogProblem(d.simvar, d.unit, d.type !== "f64");
        assert.equal(problem, null, `${group}: ${d.simvar} (${d.unit}): ${problem}`);
      }
    }
    // Every table entry was expanded (and so checked) at least once above.
    assert.deepEqual(
      SIMVARS.filter((s) => !seen.has(s.key)).map((s) => s.name),
      [],
    );
  });

  it("covers the AI traffic definition", () => {
    for (const d of AI_TRAFFIC_DATUMS) {
      const problem = catalogProblem(d.simvar, d.unit, d.type !== "f64");
      assert.equal(problem, null, `AI: ${d.simvar}: ${problem}`);
    }
  });

  it("covers every system event and system state", () => {
    const events = new Set(SYSTEM_EVENT_CATALOG.map((e) => e.toLowerCase()));
    for (const name of SYSTEM_EVENTS) assert.ok(events.has(name.toLowerCase()), `event ${name}`);
    for (const name of SYSTEM_STATES) assert.ok(SYSTEM_STATE_CATALOG.includes(name), name);
  });

  it("the literal-name scan catches a literal name", () => {
    assert.ok(literalCall.test(`h.addToDataDefinition(def, "PLANE ALTITUDE", "feet", t)`));
    assert.ok(literalCall.test(`h.addToDataDefinition(\n  ids.defineId,\n  "X",\n  null)`));
    assert.ok(literalCall.test(`handle.subscribeToSystemEvent(7, "Pause")`));
    assert.ok(literalCall.test(`handle.requestSystemState(SYSTEM_STATE_SIM_REQUEST, "Sim")`));
    assert.ok(!literalCall.test(`h.addToDataDefinition(def.defineId, datum.simvar, "x")`));
  });

  it("rejects unknown names, wrong units, wrong datum types and wrong indexing", () => {
    assert.match(
      catalogProblem("IS ON GROUND", "bool", false) ?? "",
      /not in the SimVar catalogue/,
    );
    assert.match(catalogProblem("PLANE ALTITUDE", "feet", false) ?? "", /not in the/);
    assert.match(catalogProblem("TOTAL WEIGHT", "gallons", false) ?? "", /not a weight unit/);
    assert.match(catalogProblem("TITLE", null, false) ?? "", /STRING datum/);
    assert.match(catalogProblem("TITLE", "string", true) ?? "", /unit must be null/);
    assert.match(catalogProblem("G FORCE", "gforce", true) ?? "", /FLOAT64/);
    assert.match(catalogProblem("PAYLOAD STATION WEIGHT", "pounds", false) ?? "", /needs an index/);
    assert.match(catalogProblem("ENG FUEL FLOW PPH:0", "pounds per hour", false) ?? "", /index/);
    assert.match(catalogProblem("TOTAL WEIGHT:1", "pounds", false) ?? "", /not indexed/);
    assert.equal(catalogProblem("ENG FUEL FLOW PPH:2", "Pounds per hour", false), null);
  });

  it("finds no SimConnect name literals outside the catalogued tables", () => {
    // Requests must go through SIMVARS / AI_TRAFFIC_DATUMS / SYSTEM_EVENTS / SYSTEM_STATES,
    // which the tests above check; a literal name in a call would bypass them.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (literalCall.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
    // The scan really looked at the SimConnect sources.
    const scanned = sourceFiles(SRC).map((f) => f.replace(/\\/g, "/"));
    assert.ok(scanned.some((f) => f.endsWith("sim/simconnect-source.ts")));
    assert.ok(scanned.some((f) => f.endsWith("sim/ai-traffic.ts")));
  });
});
