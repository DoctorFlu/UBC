import * as z from "zod";
import { categoriesFromMask, categoryLabel, formatCents, headroom } from "@mandate/shared";
import { ok, reason, summarizeVerdict, verdictSchema, type Reason } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { isoFromUnix } from "../support/format";

const PolicyViewSchema = z.object({
  policyAddress: z.string(),
  blockNumber: z.int().describe("Block all values were read at"),
  readAt: z.string().describe("Time of that block, ISO 8601 UTC"),
  rules: z.object({
    budgetCents: z.int().describe("Lifetime cap on committed buys"),
    maxTradeCents: z.int().describe("Largest single trade"),
    allowedCategories: z.array(z.string()),
    approvalAboveCents: z.int().nullable().describe("Trades above this wait for the owner; null: never"),
    dailyLossCents: z.int().nullable().describe("Realized loss per UTC day that stops trading; null: off"),
    paused: z.boolean(),
  }),
  used: z.object({
    committedCents: z.int().describe("Budget used by approved buys"),
    lossTodayCents: z.int().describe("Realized loss recorded today (UTC)"),
  }),
  headroom: z.object({
    remainingBudgetCents: z.int(),
    maxNextBuyCents: z
      .int()
      .describe("Largest buy that would not be rejected now (it may still need approval)"),
    maxNextSellCents: z.int(),
    remainingDailyLossCents: z.int().nullable(),
    dailyLossLimitReached: z.boolean(),
  }),
  contract: z.object({
    previewTrade: z.boolean().describe("simulate_trade can ask the contract itself"),
    contextHash: z.boolean().describe("The decision-context hash is recorded onchain with each intent"),
  }),
  agent: z.object({
    address: z.string().nullable(),
    isContractAgent: z.boolean().describe("The contract accepts this server's key as its agent"),
  }),
});

export const getPolicy = defineTool({
  name: "get_policy",
  title: "Read the mandate",
  description:
    "Reads the owner's rules (the mandate) from the Policy contract on Arc: budget, max trade size, allowed categories, approval threshold, daily loss limit and pause, plus what is used and the headroom left. Money is in integer cents. Call it before planning or proposing a trade.",
  inputSchema: z.object({}),
  outputSchema: verdictSchema({ policy: PolicyViewSchema.nullable() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    if (ctx.policy === undefined) {
      const v = unavailableFor(notConfigured.policy());
      return { structured: { ...v, policy: null }, summary: summarizeVerdict(v) };
    }
    const policy = ctx.policy;
    let read;
    try {
      read = await Promise.all([policy.snapshot(), policy.capabilities(), policy.roles()]);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, policy: null }, summary: summarizeVerdict(v) };
    }
    const [snapshot, capabilities, roles] = read;
    const { rules } = snapshot;
    const room = headroom(rules, snapshot);
    const isContractAgent =
      policy.agentAddress !== undefined && roles.agent.toLowerCase() === policy.agentAddress.toLowerCase();
    const categories = categoriesFromMask(rules.allowedCategories).map(categoryLabel);

    const reasons: Reason[] = [];
    if (rules.paused)
      reasons.push(reason("AGENT_PAUSED", "The owner has paused the agent; every trade is rejected."));
    if (policy.agentAddress === undefined) {
      reasons.push(
        reason("AGENT_KEY_NOT_CONFIGURED", "The server has no agent key, so it can read but not propose."),
      );
    } else if (!isContractAgent) {
      reasons.push(
        reason("NOT_THE_AGENT", "The contract's agent is not this server's key, so proposals will fail."),
      );
    }
    if (room.dailyLossLimitReached) {
      reasons.push(
        reason("DAILY_LOSS_LIMIT_REACHED", "Today's loss limit is reached; trading resumes at 00:00 UTC."),
      );
    }
    const v = ok(
      reasons,
      rules.paused || !isContractAgent
        ? { actor: "owner", hint: "Call get_setup_state and tell the owner what it lists." }
        : {
            actor: "agent",
            hint: "Use these limits when planning: call get_portfolio, then get_ladder and plan_hedge.",
          },
    );

    const pieces = [
      `Budget ${formatCents(rules.budgetCents)} (${formatCents(room.remainingBudgetCents)} left)`,
      `max trade ${formatCents(rules.maxTradeCents)}`,
      rules.approvalAboveCents === 0
        ? "no approval threshold"
        : `owner approves trades above ${formatCents(rules.approvalAboveCents)}`,
      rules.dailyLossCents === 0
        ? "no daily loss limit"
        : `daily loss limit ${formatCents(rules.dailyLossCents)} (${formatCents(room.remainingDailyLossCents ?? 0)} left today)`,
      `categories ${categories.length === 0 ? "none" : categories.join(", ")}`,
    ];
    const summary = `${pieces.join(", ")}. ${rules.paused ? "PAUSED by the owner." : "Not paused."}${
      reasons.length > 0 && !rules.paused ? ` ${reasons.map((r) => r.message).join(" ")}` : ""
    }`;

    return {
      structured: {
        ...v,
        policy: {
          policyAddress: policy.policyAddress,
          blockNumber: snapshot.blockNumber,
          readAt: isoFromUnix(snapshot.blockTimestamp),
          rules: {
            budgetCents: rules.budgetCents,
            maxTradeCents: rules.maxTradeCents,
            allowedCategories: categories,
            approvalAboveCents: room.approvalAboveCents,
            dailyLossCents: rules.dailyLossCents === 0 ? null : rules.dailyLossCents,
            paused: rules.paused,
          },
          used: { committedCents: snapshot.committedCents, lossTodayCents: snapshot.lossTodayCents },
          headroom: {
            remainingBudgetCents: room.remainingBudgetCents,
            maxNextBuyCents: room.maxNextBuyCents,
            maxNextSellCents: room.maxNextSellCents,
            remainingDailyLossCents: room.remainingDailyLossCents,
            dailyLossLimitReached: room.dailyLossLimitReached,
          },
          contract: { previewTrade: capabilities.previewTrade, contextHash: capabilities.proposeWithContext },
          agent: { address: policy.agentAddress ?? null, isContractAgent },
        },
      },
      summary,
    };
  },
});
