import * as z from "zod";
import { categoryMask, type PolicyRules, type ProposedRules } from "@mandate/shared";
import { held, reason, rejected, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { CategoryNameSchema, categoryIdOf } from "../support/format";
import { PROPOSED_RULE_TEXT, proposedRuleValue } from "../support/rules";

const cents = (what: string) =>
  z.int().min(0).max(1_000_000_000_000).optional().describe(`${what}, in integer cents`);

const ChangeSchema = z.object({
  rule: z.string(),
  from: z.string().nullable().describe("Current value, or null if the policy could not be read"),
  to: z.string(),
});

export const requestPolicyChange = defineTool({
  name: "request_policy_change",
  title: "Ask the owner to change a rule",
  description:
    "Files a request in the console asking the owner to change one or more rules of the mandate (budget, max trade size, allowed categories, approval threshold, daily loss limit), with a required reason. It changes nothing by itself: the owner sees the request as a diff in the console and only the owner's wallet can apply it. Pausing and unpausing are the owner's alone and cannot be requested. Use it only when the owner asks for a different rule, or after a rejection the owner wants to address.",
  inputSchema: z.strictObject({
    budgetCents: cents("Lifetime budget for buys"),
    maxTradeCents: cents("Largest single trade"),
    allowedCategories: z
      .array(CategoryNameSchema)
      .max(7)
      .optional()
      .describe("The full list of categories to allow, e.g. ['Crypto', 'Economics']"),
    approvalAboveCents: cents("Trades above this wait for the owner; 0 turns approvals off"),
    dailyLossCents: cents("Realized loss per UTC day that stops trading; 0 turns it off"),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe("Why, in the owner's terms: shown to the owner next to the diff"),
  }),
  outputSchema: verdictSchema({
    request: z
      .object({
        id: z.string(),
        status: z.enum(["pending", "applied", "dismissed"]),
        createdAt: z.string(),
        changes: z.array(ChangeSchema),
      })
      .nullable(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.console === undefined) {
      const v = unavailableFor(notConfigured.console());
      return { structured: { ...v, request: null }, summary: summarizeVerdict(v) };
    }
    if (ctx.config.agentAddress === undefined) {
      const v = unavailableFor(notConfigured.agentKey());
      return { structured: { ...v, request: null }, summary: summarizeVerdict(v) };
    }

    const asked: ProposedRules = {
      ...(input.budgetCents === undefined ? {} : { budgetCents: input.budgetCents }),
      ...(input.maxTradeCents === undefined ? {} : { maxTradeCents: input.maxTradeCents }),
      ...(input.allowedCategories === undefined
        ? {}
        : { allowedCategories: categoryMask(input.allowedCategories.map(categoryIdOf)) }),
      ...(input.approvalAboveCents === undefined ? {} : { approvalAboveCents: input.approvalAboveCents }),
      ...(input.dailyLossCents === undefined ? {} : { dailyLossCents: input.dailyLossCents }),
    };

    // The current rules make the request a diff; without them, the console still computes it.
    let current: PolicyRules | undefined;
    if (ctx.policy !== undefined) {
      try {
        current = (await ctx.policy.snapshot()).rules;
      } catch (error) {
        describeFailure(error, ctx);
      }
    }
    const proposed: ProposedRules = Object.fromEntries(
      Object.entries(asked).filter(([rule, value]) => current?.[rule as keyof ProposedRules] !== value),
    );
    const rules = Object.keys(proposed) as (keyof ProposedRules)[];
    if (rules.length === 0) {
      const v = rejected(
        [reason("NO_CHANGE", "Every value asked for is already the current rule, or none was given.")],
        {
          actor: "agent",
          hint: "Call get_policy and ask only for values that differ from the current rules.",
        },
      );
      return { structured: { ...v, request: null }, summary: summarizeVerdict(v) };
    }

    let filed;
    try {
      filed = await ctx.console.postPolicyChangeRequest(
        { agentAddress: ctx.config.agentAddress, proposed, reason: input.reason },
        ctx.signal,
      );
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, request: null }, summary: summarizeVerdict(v) };
    }

    const changes = rules.map((rule) => ({
      rule: PROPOSED_RULE_TEXT[rule],
      from: current === undefined ? null : proposedRuleValue(rule, current[rule]),
      to: proposedRuleValue(rule, proposed[rule] ?? 0),
    }));
    const v = held([reason("OWNER_DECIDES", "The request waits for the owner; nothing changed yet.")], {
      actor: "owner",
      hint: "Review the request in the console. Only the owner's wallet can apply it; until then the current rules hold.",
    });
    const diff = changes.map((c) => `${c.rule} ${c.from ?? "?"} to ${c.to}`).join(", ");
    return {
      structured: {
        ...v,
        request: { id: filed.id, status: filed.status, createdAt: filed.createdAt, changes },
      },
      summary: `Change request ${filed.id} filed for the owner: ${diff}. The current rules still apply until the owner applies it in the console.`,
    };
  },
});
