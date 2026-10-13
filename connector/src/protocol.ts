// Single import point for the shared wire protocol. The connector compiles
// `packages/protocol/src` together with its own sources (see tsconfig.json and
// README "Protocol sharing"), so the exact same zod schemas validate both ends.
export * from "../../packages/protocol/src/index";
