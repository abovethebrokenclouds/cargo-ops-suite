// Recorder: appends every frame the store broadcasts as a FixtureFrame JSONL line.
// The first line is a snapshot of the state at the moment recording starts, so
// the file replays on its own with `--sim fake --fixture <file>`.

import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { encodeFixtureLine, type Frame } from "../protocol";
import type { StateStore } from "./store";

export class Recorder {
  private fd: number | null;
  private readonly startedAt: number;
  private unsubscribe: () => void;
  lines = 0;

  constructor(
    readonly path: string,
    store: StateStore,
    private readonly now: () => number = Date.now,
  ) {
    // Never append a second recording to an existing one: its t would restart at 0.
    if (existsSync(path) && statSync(path).size > 0) {
      throw new Error(`Recording file ${path} already exists; choose a new file name`);
    }
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
    this.startedAt = this.now();
    this.write(store.snapshot());
    this.unsubscribe = store.subscribe((frame) => this.write(frame));
  }

  private write(frame: Frame): void {
    if (this.fd === null) return;
    const t = Math.max(0, this.now() - this.startedAt);
    writeSync(this.fd, `${encodeFixtureLine({ t, msg: frame })}\n`);
    this.lines++;
  }

  close(): void {
    this.unsubscribe();
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
