/**
 * `@mandate/redteam`: a scripted adversary with the agent's own capabilities (the MCP server's
 * bearer token and the agent key) that tries to break the mandate, and records every attempt.
 */
import { randomBytes } from "node:crypto";
import { devAccount } from "@mandate/devchain";
import { amountsFor, attacks, preconditions } from "./attacks";
import { endState, runAttacks } from "./run";
import { TargetRefused, type TargetHandle } from "./targets";
import type { AttackContext, AttackRecord, RunReport } from "./types";

export { attacks, amountsFor, preconditions } from "./attacks";
export { connectStack, startSelf, TargetRefused, type TargetHandle } from "./targets";
export { line, markdown, passed, summarize, summaryLine, endStateLines } from "./report";
export type * from "./types";

/** Runs every attack against a connected target and returns the full report. */
export async function runRedTeam(
  target: TargetHandle,
  onRecord: (record: AttackRecord) => void = () => undefined,
): Promise<RunReport> {
  const snapshot = await target.reader.getSnapshot();
  const problems = preconditions(snapshot.rules, snapshot);
  if (problems.length > 0) {
    throw new TargetRefused(`the rules do not fit the attacks: ${problems.join("; ")}`);
  }
  const amounts = amountsFor(snapshot.rules);
  const ctx: AttackContext = {
    target: target.target,
    runId: randomBytes(3).toString("hex"),
    rules: snapshot.rules,
    amounts,
    markets: target.markets,
    mcp: target.mcp,
    chain: target.chain,
    reader: target.reader,
    owner: target.owner,
    executor: target.executor,
    venue: target.venue,
    outsider: devAccount("outsider").address,
    serverLogs: target.target === "self" ? target.serverLogs : null,
    state: { heldIntentId: null, heldIntentIds: [], approved: [], injectionIntentId: null, untradeable: [] },
  };
  const before = {
    intents: await target.reader.getIntentCount(),
    committedCents: snapshot.committedCents,
    roles: await target.reader.getRoles(),
  };
  const outcome = await runAttacks(ctx, attacks(amounts), onRecord);
  const end = await endState(ctx, before);
  const records = [...outcome.records];
  if (end.committedAfterCents > end.budgetCents) {
    const breach: AttackRecord = {
      id: "invariant.budget",
      name: "Committed spend stays within the budget",
      surface: "chain",
      tried: "Read committed spend after every attack.",
      expected: "Committed spend at or below the budget.",
      expectedVerdict: "held",
      verdict: "BREACH",
      actual: `committed ${end.committedAfterCents} cents, budget ${end.budgetCents} cents`,
      limit: null,
      finding: null,
      txHashes: [],
      intentIds: [],
      asExpected: false,
    };
    records.push(breach);
    onRecord(breach);
  }
  return {
    target: target.target,
    contract: target.contract,
    policy: target.policy,
    rpcUrl: target.rpcUrl,
    mcpUrl: target.mcpUrl,
    rules: snapshot.rules,
    attacks: records,
    endState: end,
    aborted: outcome.aborted,
  };
}
