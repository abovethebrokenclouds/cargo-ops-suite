import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";

import { loadDemoDomains, useDemoDomains } from "./company";
import { demoDomains } from "./demo-domains";

const airports = JSON.parse(
  readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
) as EconomyAirport[];
const lookup = airportLookup(airports);
const expected = demoDomains(lookup);

describe("DEMO company off the main thread", () => {
  it("survives the worker boundary unchanged (structured clone)", () => {
    expect(structuredClone(expected)).toEqual(expected);
  });

  it("the worker answers the airport list with the same domains as the page", async () => {
    const posted: unknown[] = [];
    const spy = vi.spyOn(self, "postMessage").mockImplementation((m: unknown) => {
      posted.push(m);
    });
    try {
      await import("./demo-domains.worker");
      self.onmessage?.(new MessageEvent("message", { data: { airports } }));
      expect(posted).toEqual([{ ok: true, domains: expected }]);
    } finally {
      spy.mockRestore();
      self.onmessage = null;
    }
  });

  it("without workers it computes once on the page, after the current task", async () => {
    expect(typeof Worker).toBe("undefined");
    const first = loadDemoDomains(lookup);
    expect(loadDemoDomains(lookup)).toBe(first);
    await expect(first).resolves.toEqual(expected);
  });

  it("the hook is null without a lookup and fills in once computed", async () => {
    const { result, rerender } = renderHook(({ l }) => useDemoDomains(l), {
      initialProps: { l: null as typeof lookup | null },
    });
    expect(result.current).toBeNull();
    rerender({ l: lookup });
    await waitFor(() => expect(result.current).toEqual(expected));
    act(() => rerender({ l: null }));
    expect(result.current).toBeNull();
  });
});
