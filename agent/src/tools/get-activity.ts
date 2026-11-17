import * as z from "zod";
import { formatCents, settlementTotals, type Intent, type IntentView } from "@mandate/shared";
import { ok, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { intentRow, IntentRowSchema } from "../support/intents";
import {
  LadderSettlementSchema,
  ladderSentence,
  readSettlements,
  settledLadders,
  SettlementTotalsSchema,
} from "../support/settlements";

/** A note on intents older than the list that still matter, or "". */
function olderIntents(waiting: number, rejected: number): string {
  const parts = [
    ...(waiting > 0 ? [`${waiting} waiting for approval`] : []),
    ...(rejected > 0 ? [`${rejected} rejected`] : []),
  ];
  return parts.length === 0 ? "" : ` Older intents: ${parts.join(", ")}.`;
}

export const getActivity = defineTool({
  name: "get_activity",
  title: "List recent intents",
  description:
    "Lists the most recent trade intents on the Policy contract, newest first, with the mandate's verdict, the rejection reason, and the fill and profit once the executor recorded a result. Use it to report to the owner or to check what happened after an unclear result.",
  inputSchema: z.object({ limit: z.int().min(1).max(25).default(10).describe("How many intents to show") }),
  outputSchema: verdictSchema({
    total: z.int().nullable().describe("All intents ever proposed on this contract"),
    intents: z.array(IntentRowSchema).nullable(),
    truncated: z.boolean().describe("Older intents exist beyond this list"),
    settlements: SettlementTotalsSchema.extend({
      ladders: z
        .array(LadderSettlementSchema)
        .describe("Settled ladders, the latest expiry first, at most 5"),
    })
      .nullable()
      .describe(
        "Every position settled so far, as the executor signed it and the console stored it (the contract cannot record a payout). null when the console cannot say.",
      ),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.policy === undefined) {
      const v = unavailableFor(notConfigured.policy());
      return {
        structured: { ...v, total: null, intents: null, truncated: false, settlements: null },
        summary: summarizeVerdict(v),
      };
    }
    const policy = ctx.policy;
    let total: number;
    let intents: Intent[];
    try {
      total = await policy.intentCount();
      const ids = Array.from({ length: Math.min(input.limit, total) }, (_, i) => total - 1 - i);
      const read = await Promise.all(ids.map((id) => policy.intent(id)));
      intents = read.filter((intent): intent is Intent => intent !== null);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return {
        structured: { ...v, total: null, intents: null, truncated: false, settlements: null },
        summary: summarizeVerdict(v),
      };
    }
    // Rejection reasons live only in events. A failed scan still leaves a useful list.
    const views: ReadonlyMap<number, IntentView> = await policy.intentEvents().catch((error: unknown) => {
      describeFailure(error, ctx);
      return new Map<number, IntentView>();
    });
    // What filled positions paid at expiry lives in the console, signed by the executor (issue #92).
    const stored = await readSettlements(ctx);
    const byIntent = new Map(stored?.map((settlement) => [settlement.intentId, settlement.document]));
    const rows = intents.map((intent) =>
      intentRow(intent, views.get(intent.id), ctx.ledger.lookup(intent.id), byIntent.get(intent.id)),
    );
    const ladders = stored === null ? null : settledLadders(stored);
    const settlements =
      stored === null || ladders === null
        ? null
        : {
            ...settlementTotals(stored.map((settlement) => settlement.document)),
            ladders: ladders.slice(0, 5),
          };

    const count = (status: string) => rows.filter((r) => r.status === status).length;
    // The events cover every intent, so an approval still waiting further back is not missed.
    const waitingIds = new Set([
      ...rows.filter((r) => r.status === "needs_approval").map((r) => r.id),
      ...[...views.values()].filter((view) => view.status === "needs_approval").map((view) => view.id),
    ]);
    const waiting = [...waitingIds].sort((a, b) => b - a);
    const olderRejected = [...views.values()].filter(
      (view) => view.status === "rejected" && !rows.some((r) => r.id === view.id),
    ).length;
    const v = ok(
      [],
      waiting.length > 0
        ? {
            actor: "owner",
            hint: `Intents ${waiting.map((id) => `#${id}`).join(", ")} wait for the owner's approval in the console.`,
          }
        : ladders !== null && ladders.length > 0
          ? {
              actor: "agent",
              hint: "Report these results to the owner in plain words, including what each expired ladder cost, paid and netted. An expired ladder is over: plan any new protection on the next ladder.",
            }
          : { actor: "agent", hint: "Report these results to the owner in plain words." },
    );
    const rejectedRows = rows.filter((r) => r.status === "rejected");
    const reasons = [...new Set(rejectedRows.map((r) => r.reason ?? "reason unknown"))];
    const filled = rows.reduce((sum, r) => sum + (r.filledCents ?? 0), 0);
    const flagged = rows.filter((r) => r.flags.length > 0).map((r) => `#${r.id}`);
    const flaggedText =
      flagged.length === 0
        ? ""
        : ` FLAGGED: ${flagged.join(", ")} could not have come from this server (see flags); the agent key was used around it, so tell the owner.`;
    const settledText =
      ladders === null
        ? ctx.console === undefined
          ? ""
          : " Settlements: the console cannot say right now, so do not report any payout."
        : ladders.length === 0
          ? ""
          : ` ${ladders
              .slice(0, 3)
              .map((ladder) => ladderSentence(ladder))
              .join(" ")}`;
    const summary =
      total === 0
        ? "No intents have been proposed on this contract yet."
        : `Latest ${rows.length} of ${total} intents: ${count("approved")} approved and waiting for the executor, ${count("executed")} executed (${formatCents(filled)} filled), ${count("failed")} failed, ${count("needs_approval")} waiting for approval, ${rejectedRows.length} rejected${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}.${olderIntents(waiting.filter((id) => !rows.some((r) => r.id === id)).length, olderRejected)}${settledText}${flaggedText}`;
    return {
      structured: { ...v, total, intents: rows, truncated: total > rows.length, settlements },
      summary,
    };
  },
});
