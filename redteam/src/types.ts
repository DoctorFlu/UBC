import type { Address, Hex } from "viem";
import type { RefusalCode, Venue } from "@mandate/devchain";
import type { PolicyClient, PolicyRules } from "@mandate/shared";
import type { ChainAttacker } from "./chain";
import type { McpAttacker } from "./mcp";

/** Where the attack comes from: the MCP server (a hostile Grok Bot) or the chain (a stolen agent key). */
export type Surface = "mcp" | "chain";

/**
 * - `held`: the mandate (or the server in front of it) stopped the attempt.
 * - `bounded`: the attempt went through, but stayed inside a limit the record names.
 * - `BREACH`: something that should be impossible happened.
 */
export type Verdict = "held" | "bounded" | "BREACH";

/** `self`: our own devchain and MCP server. `stack`: the running `npm run dev:stack`. */
export type Target = "self" | "stack";

/** What one attack observed. The attack decides the verdict from what actually happened. */
export interface Observation {
  verdict: Verdict;
  actual: string;
  /**
   * False when the outcome differs from the expected one in detail (for example the contract refused
   * with a different reason) without being a breach. The run then reports the attack as unexpected.
   */
  matched?: boolean;
  txHashes?: Hex[];
  intentIds?: number[];
}

/** Owner-side setup that some attacks need, undone afterwards where the contract allows it. */
export type Scenario = "paused" | "daily-loss";

export interface Attack {
  /** Stable id, `<surface>.<slug>`. */
  id: string;
  name: string;
  surface: Surface;
  /** What the attacker tries, in one or two sentences. */
  tried: string;
  /** What should happen. */
  expected: string;
  expectedVerdict: Verdict;
  /** For `bounded`: the limit that bounds it. */
  limit?: string;
  /** A gap or limitation this attack shows, stated plainly. */
  finding?: string;
  /** Owner-side setup that must be in place while the attack runs. */
  scenario?: Scenario;
  /** Why the attack does not run against the live stack, when it does not. */
  selfOnly?: string;
  run: (ctx: AttackContext) => Promise<Observation>;
}

/** Amounts derived from the live rules, so the same attacks fit any rules that meet the preconditions. */
export interface Amounts {
  /** Above the max trade size. */
  overMax: number;
  /** `overMax` split into orders that each pass the max trade size and stay at or below the approval threshold. */
  splitParts: number[];
  /** Above the approval threshold, at or below the max trade size. */
  overThreshold: number;
  /** A small order for attacks where the size does not matter. */
  probe: number;
  /** The largest order that needs no approval. */
  piece: number;
}

/** State the attacks hand to each other, in run order. */
export interface SharedState {
  /** An intent waiting for the owner, created by the attacker. */
  heldIntentId: number | null;
  /** Intents created as held by this run. */
  heldIntentIds: number[];
  /** Approved buys created by this run, with their amounts. */
  approved: { intentId: number; amountCents: number }[];
  /** The intent whose market string carries a prompt injection, planted with the agent key. */
  injectionIntentId: number | null;
  /**
   * Approved intents the MCP server could never have sent, planted with the agent key, and the reason
   * the executor must give for refusing each (`chain.executor-refuses` checks them).
   */
  untradeable: { intentId: number; label: string; refusal: RefusalCode }[];
}

export interface AttackContext {
  target: Target;
  /** Short random id, appended to reasons so a second run is not mistaken for a retry. */
  runId: string;
  rules: PolicyRules;
  amounts: Amounts;
  markets: { crypto: string; sports: string | null };
  mcp: McpAttacker;
  chain: ChainAttacker;
  /** Read-only client for checks. */
  reader: PolicyClient;
  /** The devchain owner, used only to set up scenarios (pause, approve a held intent). */
  owner: PolicyClient;
  /** The devchain executor, used only to set up the daily-loss scenario on our own chain. */
  executor: PolicyClient | null;
  /** Where the executor looks up a market before trading: the recorded markets here, Gemini on the stack. */
  venue: Venue;
  /** Addresses for role attacks. */
  outsider: Address;
  /** The MCP server's log lines, when the red team runs the server itself; null against the live stack. */
  serverLogs: readonly string[] | null;
  state: SharedState;
}

export interface AttackRecord {
  id: string;
  name: string;
  surface: Surface;
  tried: string;
  expected: string;
  expectedVerdict: Verdict;
  /** `ERROR` when the attack itself failed to run, `SKIPPED` when it does not apply to this target. */
  verdict: Verdict | "ERROR" | "SKIPPED";
  actual: string;
  limit: string | null;
  finding: string | null;
  txHashes: Hex[];
  intentIds: number[];
  /** The verdict is the expected one. False for any surprise, including an `ERROR`. */
  asExpected: boolean;
}

export interface EndState {
  intentsBefore: number;
  intentsAfter: number;
  committedBeforeCents: number;
  committedAfterCents: number;
  budgetCents: number;
  paused: boolean;
  rolesUnchanged: boolean;
  rulesUnchanged: boolean;
  /** Intents this run created that still wait for the owner. */
  heldIntentIds: number[];
}

export interface RunReport {
  target: Target;
  contract: string;
  policy: Address;
  rpcUrl: string;
  mcpUrl: string;
  rules: PolicyRules;
  attacks: AttackRecord[];
  endState: EndState | null;
  /** Set when the run stopped early because owner-only state changed. */
  aborted: string | null;
}

export interface RunSummary {
  held: number;
  bounded: number;
  breach: number;
  errors: number;
  skipped: number;
  unexpected: number;
}
