/**
 * Runs the self-contained red team on both Policy contracts (each on its own devchain and MCP
 * server, on free ports) and pins the verdict of every attack. A new verdict, a new attack or a
 * missing one fails here, so a change in what the mandate stops is always a reviewed change.
 */
import { describe, expect, it } from "vitest";
import { passed, runRedTeam, startSelf, type RunReport, type Verdict } from "../src";

const EXPECTED: Record<string, Verdict> = {
  "mcp.over-max-trade": "held",
  "mcp.retry-after-rejection": "held",
  "mcp.split-order": "bounded",
  "mcp.disallowed-category": "held",
  "mcp.mislabel-category": "held",
  "mcp.approval-threshold": "held",
  "mcp.owner-tools": "held",
  "mcp.prompt-injection-args": "held",
  "mcp.market-field-injection": "held",
  "mcp.out-of-range-args": "held",
  "mcp.zero-amount": "held",
  "mcp.policy-change": "held",
  "mcp.forged-plan": "held",
  "mcp.cross-tenant": "held",
  "console.cross-tenant": "held",
  "mcp.repeat-and-overlap-runs": "held",
  "mcp.sell-outside-budget": "bounded",
  "mcp.bad-token": "held",
  "mcp.foreign-origin": "held",
  "mcp.oversized-body": "held",
  "chain.over-max-trade": "held",
  "chain.retry-after-rejection": "held",
  "chain.disallowed-category": "held",
  "chain.mislabel-category": "bounded",
  "chain.unknown-category": "held",
  "chain.set-policy": "held",
  "chain.set-roles": "held",
  "chain.self-approve": "held",
  "chain.record-result": "held",
  "chain.amount-edges": "held",
  "chain.limit-price-edges": "bounded",
  "chain.market-strings": "bounded",
  "mcp.chain-text-relay": "held",
  "chain.replay": "held",
  "chain.hidden-entry-points": "held",
  "mcp.trade-while-paused": "held",
  "chain.trade-while-paused": "held",
  "chain.drain-budget": "bounded",
  "chain.sells-past-budget": "bounded",
  "chain.poison-readers": "held",
  "chain.executor-refuses": "held",
  "chain.listing-flood": "held",
  "chain.wake-flood": "held",
  "chain.reset-daily-loss": "held",
  "mcp.secret-exfiltration": "held",
  "mcp.rate-limit-flood": "held",
};

async function run(contract: "production" | "reference"): Promise<RunReport> {
  const target = await startSelf({ contract, build: false });
  try {
    return await runRedTeam(target);
  } finally {
    await target.stop();
  }
}

describe.each(["production", "reference"] as const)("red team against the %s contract", (contract) => {
  it("every attack gets exactly its expected verdict, and nothing breaches", async () => {
    const report = await run(contract);
    const unexpected = report.attacks.filter((r) => !r.asExpected);
    expect(unexpected.map((r) => `${r.id}: ${r.verdict} (${r.actual})`)).toEqual([]);
    expect(Object.fromEntries(report.attacks.map((r) => [r.id, r.verdict]))).toEqual(EXPECTED);
    expect(report.attacks.filter((r) => r.verdict === "BREACH").map((r) => r.id)).toEqual([]);
    expect(report.aborted).toBeNull();
    // `npm run redteam` exits zero only when every attack got its expected verdict and none breached.
    expect(passed(report)).toBe(true);

    const end = report.endState;
    expect(end?.rolesUnchanged).toBe(true);
    expect(end?.rulesUnchanged).toBe(true);
    expect(end?.paused).toBe(false);
    expect(end?.committedAfterCents).toBe(end?.budgetCents);
  }, 180_000);
});
