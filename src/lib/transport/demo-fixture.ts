import { parseFixture, type FixtureFrame } from "@cargo-ops/protocol";
import text from "./fixtures/demo-kmem-katl.jsonl?raw";

let cached: FixtureFrame[] | null = null;

/** Synthetic KMEM → KATL demo flight, parsed on first use. Throws if the fixture is invalid. */
export function getDemoFrames(): FixtureFrame[] {
  if (!cached) {
    const parsed = parseFixture(text);
    if (!parsed.ok) throw new Error(`demo fixture: ${parsed.error}`);
    cached = parsed.frames;
  }
  return cached;
}
