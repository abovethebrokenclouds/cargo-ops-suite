import { z } from "zod";
import { simStatePatchSchema, simStateSchema } from "./state";

// Wire protocol between the local connector and the web app (plan §3.2).
// Every message is a JSON object discriminated by `type` and carries `v`.

export const PROTOCOL_VERSION = 1 as const;

const v = z.literal(PROTOCOL_VERSION);
const seq = z.number().int().nonnegative();

/** Where a frame's data came from. Drives the status chip; never inferred. */
export const sourceSchema = z.enum(["sim", "replay", "demo"]);
export type Source = z.infer<typeof sourceSchema>;

export const modeSchema = z.enum(["live", "demo", "replay"]);
export type Mode = z.infer<typeof modeSchema>;

export const topicSchema = z.enum(["telemetry", "flight", "jobs", "company"]);
export type Topic = z.infer<typeof topicSchema>;

export const EVENT_NAMES = [
  "sim.connected",
  "sim.disconnected",
  "sim.paused",
  "sim.rate",
  "flight.started",
  "phase.changed",
  "touchdown",
  "flight.ended",
  "job.completed",
  "crash",
  // P3 cargo operations (additive).
  "mission.started",
  "mission.delivered",
  "mission.failed",
  // P4 company, fleet and finance (additive).
  "loan.payment",
  "loan.missed",
  "aircraft.repossessed",
  "repair.completed",
  // P5 used aircraft and airworthiness (additive).
  "defect.found",
  "inspection.completed",
  "aircraft.grounded",
] as const;
export const eventNameSchema = z.enum(EVENT_NAMES);
export type EventName = z.infer<typeof eventNameSchema>;

/** Command names known today; the schema accepts any dotted name for forward compatibility. */
export const KNOWN_COMMANDS = [
  "job.accept",
  "job.load",
  "flight.start",
  "flight.end",
  "settings.update",
  "fleet.buy",
  // P3 cargo operations.
  "jobs.list",
  "jobs.refresh",
  "job.release",
  "mission.load",
  "mission.unload",
  "mission.abort",
  // P4 fleet and finance.
  "fleet.sell",
  "fleet.lease",
  "fleet.return",
  "fleet.repair",
  "fleet.select",
  "loan.quote",
  "loan.take",
  "loan.payoff",
  // P5 used market and airworthiness.
  "market.refresh",
  "market.inspect",
  "market.buy",
  "fleet.repairDefect",
  "fleet.repairAll",
  "fleet.annual",
  "fleet.ferryPermit",
  "fleet.defer",
] as const;
export type KnownCommandName = (typeof KNOWN_COMMANDS)[number];

// ---- client → server ----

export const helloSchema = z.object({
  type: z.literal("hello"),
  v,
  token: z.string().min(1),
  client: z.literal("web"),
  wants: z.array(topicSchema),
});

export const commandSchema = z.object({
  type: z.literal("command"),
  v,
  id: z.string().min(1),
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, "expected a dotted command name"),
  args: z.unknown(),
});

export const resyncSchema = z.object({
  type: z.literal("resync"),
  v,
  /** Last seq applied by the client; -1 when it has none. */
  lastSeq: z.number().int().min(-1),
});

// ---- either direction ----

export const pingSchema = z.object({
  type: z.literal("ping"),
  v,
  /** Sender clock, ms; echoed in the pong for RTT. */
  t: z.number().finite(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
  v,
  t: z.number().finite(),
});

// ---- server → client ----

export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  v,
  session: z.string().min(1),
  mode: modeSchema,
  sim: z.object({
    connected: z.boolean(),
    /** e.g. "MSFS 2024". */
    name: z.string().optional(),
    version: z.string().optional(),
    /** SimConnect binding in use, e.g. "SunRise". */
    protocol: z.string().optional(),
  }),
});

const frameBase = { v, seq, source: sourceSchema };

export const snapshotSchema = z.object({
  type: z.literal("snapshot"),
  ...frameBase,
  state: simStateSchema,
});

export const deltaSchema = z.object({
  type: z.literal("delta"),
  ...frameBase,
  patch: simStatePatchSchema,
});

export const eventSchema = z.object({
  type: z.literal("event"),
  ...frameBase,
  name: eventNameSchema,
  data: z.unknown(),
});

export const resultSchema = z.union([
  z.object({
    type: z.literal("result"),
    v,
    id: z.string().min(1),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal("result"),
    v,
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1),
      message: z.string(),
      /** P5: every blocking reason (e.g. the airworthiness gate), when there are several. */
      reasons: z.array(z.object({ code: z.string().min(1), message: z.string() })).optional(),
    }),
  }),
]);

export type Hello = z.infer<typeof helloSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Resync = z.infer<typeof resyncSchema>;
export type Ping = z.infer<typeof pingSchema>;
export type Pong = z.infer<typeof pongSchema>;
export type Welcome = z.infer<typeof welcomeSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Delta = z.infer<typeof deltaSchema>;
export type SimEvent = z.infer<typeof eventSchema>;
export type Result = z.infer<typeof resultSchema>;

export type Frame = Snapshot | Delta | SimEvent;
export type ServerMessage = Welcome | Frame | Result | Ping | Pong;
export type ClientMessage = Hello | Command | Resync | Ping | Pong;

export const serverMessageSchema = z.union([
  welcomeSchema,
  snapshotSchema,
  deltaSchema,
  eventSchema,
  resultSchema,
  pingSchema,
  pongSchema,
]);
export const clientMessageSchema = z.union([
  helloSchema,
  commandSchema,
  resyncSchema,
  pingSchema,
  pongSchema,
]);

const serverSchemas: Record<ServerMessage["type"], z.ZodTypeAny> = {
  welcome: welcomeSchema,
  snapshot: snapshotSchema,
  delta: deltaSchema,
  event: eventSchema,
  result: resultSchema,
  ping: pingSchema,
  pong: pongSchema,
};

const clientSchemas: Record<ClientMessage["type"], z.ZodTypeAny> = {
  hello: helloSchema,
  command: commandSchema,
  resync: resyncSchema,
  ping: pingSchema,
  pong: pongSchema,
};

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseWith<T>(input: unknown, schemas: Record<string, z.ZodTypeAny>): ParseResult<T> {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }
  if (!isRecord(value)) return { ok: false, error: "message must be a JSON object" };
  if (value["v"] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version ${JSON.stringify(value["v"])} (expected ${PROTOCOL_VERSION})`,
    };
  }
  const type = value["type"];
  const schema = typeof type === "string" && Object.hasOwn(schemas, type) ? schemas[type] : null;
  if (!schema) return { ok: false, error: `unknown message type ${JSON.stringify(type)}` };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `${type}: ${formatIssues(parsed.error)}` };
  return { ok: true, msg: parsed.data as T };
}

/** Validate a server → client message. Accepts a decoded value or a raw JSON string. */
export function parseServerMessage(json: unknown): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(json, serverSchemas);
}

/** Validate a client → server message. Accepts a decoded value or a raw JSON string. */
export function parseClientMessage(json: unknown): ParseResult<ClientMessage> {
  return parseWith<ClientMessage>(json, clientSchemas);
}

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function isFrame(msg: ServerMessage): msg is Frame {
  return msg.type === "snapshot" || msg.type === "delta" || msg.type === "event";
}
