/**
 * Issue #97: the daily digest (`agent/grok/digest.md`) reads, and never trades.
 *
 * Each test builds a day through the tools (the hourly routine, a call outside it, a settlement), then
 * makes the digest's calls the way Grok Bot makes them: one fresh MCP session per call, over HTTP, against
 * the real MCP server, a real Policy contract on anvil, the simulated executor and the fake console.
 * The server sums the day and the console measures the cover; the digest only reads the result.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_AGENT_API_BASE } from "@mandate/shared";
import { DIGEST_CONSOLE_URL, digest, quietDay, settledDay, waitingDay, type Day } from "./digest-days";
import { field, type ToolResult } from "./stack";

let day: Day | undefined;
afterEach(async () => {
  await day?.stack.stop();
  day = undefined;
});

/** The digest's calls, checked to leave the chain, the console and the signal wallet as they were. */
async function readOnlyDigest(d: Day): Promise<Record<string, ToolResult>> {
  const intentsBefore = await d.stack.intents();
  const requestsBefore = d.stack.console.state.requests.length;
  const results = await digest(d.stack);
  for (const [name, result] of Object.entries(results)) {
    expect(result.isError, name).toBe(false);
    expect(field(result.structured, "status"), name).toBe("ok");
  }
  expect(await d.stack.intents()).toEqual(intentsBefore);
  const requests = d.stack.console.state.requests.slice(requestsBefore);
  const writes = requests.filter(
    (request) => !request.startsWith("GET ") && request !== `POST ${CONSOLE_AGENT_API_BASE}/auth/resolve`,
  );
  expect(writes).toEqual([]);
  expect(requests).toContain(`GET ${CONSOLE_AGENT_API_BASE}/summary`);
  expect(d.bought).toEqual([]);
  return results;
}

describe("the daily digest against the real server, chain and executor (issue #97)", () => {
  it("a quiet day: nothing proposed, the goal still covered, nothing waiting", async () => {
    day = await quietDay();
    const results = await readOnlyDigest(day);
    const activity = results["get_activity"]?.structured;
    expect(field(activity, "last24h")).toMatchObject({
      complete: true,
      proposed: 0,
      filledCents: 0,
      signals: { bought: 0, spentUsdc: "0" },
      settled: { positions: 0 },
    });
    expect(field(activity, "waitingForOwner")).toMatchObject({ intents: [], changeRequests: [] });
    expect(results["get_activity"]?.text).toContain(
      "Last 24 hours: no intents proposed. No signals bought. Nothing settled. Nothing waits for the owner.",
    );
    const cover = field(results["get_portfolio"]?.structured, "cover") as Record<string, unknown>[];
    expect(cover).toEqual([
      expect.objectContaining({
        asset: "BTC",
        state: "met",
        coverBps: 10_000,
        link: `${DIGEST_CONSOLE_URL}/hedge`,
      }),
    ]);
  });

  it("a day with a settlement: what the expired ladder cost, paid and netted, and today's spend", async () => {
    day = await settledDay();
    const results = await readOnlyDigest(day);
    const activity = results["get_activity"]?.structured;
    const intents = await day.stack.intents();
    const filled = intents.reduce((sum, intent) => sum + (intent.filledCents ?? 0), 0);
    const settled = [...day.stack.console.state.settlements.values()].map((s) => s.document);
    expect(field(activity, "last24h")).toMatchObject({
      proposed: intents.length,
      executed: intents.length,
      filledCents: filled,
      signals: { bought: 2, spentUsdc: "0.02" },
      settled: {
        positions: settled.length,
        costCents: settled.reduce((sum, doc) => sum + doc.costCents, 0),
        payoutCents: settled.reduce((sum, doc) => sum + doc.payoutCents, 0),
        pnlCents: settled.reduce((sum, doc) => sum + doc.pnlCents, 0),
      },
    });
    expect(results["get_activity"]?.text).toMatch(/Settled: Ladder BTC2611202200 .* net [+-]\$/);
    // The goal now sits on the next ladder.
    expect(field(results["get_portfolio"]?.structured, "cover")).toEqual([
      expect.objectContaining({ eventTicker: "BTC2611272200", state: "met" }),
    ]);
  });

  it("a day with something waiting for the owner: the held intent and the change request, with links", async () => {
    day = await waitingDay();
    const results = await readOnlyDigest(day);
    const waiting = field(results["get_activity"]?.structured, "waitingForOwner") as Record<string, unknown>;
    const held = (await day.stack.intents()).filter((intent) => intent.status === "needs_approval");
    expect(held).toHaveLength(1);
    expect(waiting).toMatchObject({
      link: `${DIGEST_CONSOLE_URL}/approvals`,
      intents: [
        {
          id: held[0]?.id,
          amountCents: held[0]?.amountCents,
          link: `${DIGEST_CONSOLE_URL}/activity/${String(held[0]?.id)}`,
        },
      ],
      changeRequests: [
        {
          id: "pcr_1",
          changes: "approval threshold to $25.00",
          reason: { untrusted: true, source: "agent" },
        },
      ],
    });
    expect(field(results["get_activity"]?.structured, "last24h")).toMatchObject({
      needsApproval: 1,
      rejected: 1,
      rejections: [{ reasonCode: "OVER_MAX_TRADE_SIZE", count: 1 }],
    });
    const text = results["get_activity"]?.text ?? "";
    expect(text).toContain(`Approvals: ${DIGEST_CONSOLE_URL}/approvals`);
    expect(text).not.toContain("every run waits for you");
    // Cover counts the held order, and says how much of it waits for the owner.
    expect(results["get_portfolio"]?.text).toContain("of it from orders waiting for the owner's approval");
  });
});
