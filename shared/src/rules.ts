/**
 * `@mandate/shared/rules`: the rule check and its vocabulary, without viem or zod, so a browser bundle
 * (the landing page's gate) can run the same `evaluateIntent` the agent and the console run.
 */
export * from "./categories";
export * from "./evaluate";
export * from "./reasons";
export { formatCents } from "./units";
export type { PolicyRules } from "./types";
