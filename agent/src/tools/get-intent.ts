import * as z from "zod";
import { formatEasternTime, verifyContext, type Intent, type IntentView } from "@mandate/shared";
import { ok, reason, summarizeVerdict, unavailable, verdictSchema, type NextAction } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import {
  amountText,
  fillSourceText,
  intentRow,
  IntentRowSchema,
  limitPriceText,
  type IntentRow,
} from "../support/intents";
import { AFTER_REJECTION } from "../support/rules";
import { orderSentence, readOrders } from "../support/orders";
import { moneyLine, readSettlements } from "../support/settlements";

const ContextCheckSchema = z.object({
  hash: z.string(),
  onchain: z.boolean().nullable().describe("The hash is recorded onchain with the intent; null if unknown"),
  document: z
    .enum(["verified", "mismatch", "missing", "unchecked"])
    .describe(
      "The console's stored document matches the hash (verified), differs (mismatch), is absent, or was not checked",
    ),
  reason: z.string().nullable().describe("The agent's stated reason, when this server proposed the intent"),
});

const IntentDetailSchema = IntentRowSchema.extend({ context: ContextCheckSchema.nullable() });

function nextFor(row: IntentRow): NextAction {
  switch (row.status) {
    case "approved":
      return { actor: "agent", hint: "The executor has not recorded a fill yet. Check again later." };
    case "needs_approval":
      return { actor: "owner", hint: `Approve or reject intent #${row.id} in the console.` };
    case "rejected":
      return AFTER_REJECTION;
    default:
      return { actor: "agent", hint: "Report the result to the owner." };
  }
}

export const getIntent = defineTool({
  name: "get_intent",
  title: "Read one intent",
  description:
    "Returns one trade intent by id (ids start at 0): its status (approved, waiting for approval, rejected, executed, failed), the contract's rejection reason, the fill and profit once recorded, and whether its sealed decision context matches the hash. Use it after propose_trade or execute_plan to follow up.",
  inputSchema: z.object({ intentId: z.int().min(0).describe("The intentId a proposal returned") }),
  outputSchema: verdictSchema({ intent: IntentDetailSchema.nullable() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.policy === undefined) {
      const v = unavailableFor(notConfigured.policy());
      return { structured: { ...v, intent: null }, summary: summarizeVerdict(v) };
    }
    let intent: Intent | null;
    try {
      intent = await ctx.policy.intent(input.intentId);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, intent: null }, summary: summarizeVerdict(v) };
    }
    if (intent === null) {
      const v = unavailable(
        [reason("INTENT_NOT_FOUND", `There is no intent #${input.intentId} on this contract.`)],
        {
          actor: "agent",
          hint: "Call get_activity to see the ids that exist.",
        },
      );
      return { structured: { ...v, intent: null }, summary: summarizeVerdict(v) };
    }
    const view: IntentView | undefined = await ctx.policy
      .intentEvents()
      .then((views) => views.get(input.intentId))
      .catch((error: unknown) => {
        describeFailure(error, ctx);
        return undefined;
      });
    const record = ctx.ledger.lookup(input.intentId);
    const [settled, order] = await Promise.all([
      intent.status === "executed"
        ? readSettlements(ctx).then(
            (stored) => stored?.find((entry) => entry.intentId === input.intentId)?.document,
          )
        : undefined,
      // An approved intent may have an order resting on Gemini; a pending or rejected one never has.
      intent.status === "approved" || intent.status === "executed" || intent.status === "failed"
        ? readOrders(ctx)
        : undefined,
    ]);
    const row = intentRow(intent, view, record, settled, order?.byIntent.get(input.intentId), order);

    let context: z.infer<typeof ContextCheckSchema> | null = null;
    if (row.contextHash !== null) {
      const hash = row.contextHash as `0x${string}`;
      let document: "verified" | "mismatch" | "missing" | "unchecked" = "unchecked";
      if (ctx.console !== undefined) {
        try {
          const stored = await ctx.console.getContext(hash, ctx.signal);
          document =
            stored === null ? "missing" : verifyContext(stored.document, hash) ? "verified" : "mismatch";
        } catch (error) {
          describeFailure(error, ctx);
        }
      }
      const onchain =
        view?.contextHash != null ? view.contextHash === hash : (record?.contextHashRecorded ?? null);
      context = { hash, onchain, document, reason: record?.reason ?? null };
    }

    const v = ok([], nextFor(row));
    // The contract's recorded result is 0 at every fill (it cannot record the settlement), so the only
    // result is the settlement's net after fees; before it, the position is open until its market expires.
    const filled = row.filledCents !== null && row.filledCents > 0;
    const result =
      row.status === "executed" || row.status === "failed"
        ? ` Filled ${amountText(row.filledCents)}${fillSourceText(row.fillSource)}.` +
          (filled && row.settlement === null && row.side === "buy"
            ? " No result yet: the position is open until its market expires and the executor records the outcome."
            : "")
        : "";
    const atExpiry =
      row.settlement === null
        ? ""
        : ` At expiry, ${formatEasternTime(row.settlement.expiresAt)}, it resolved ${row.settlement.resolution.toUpperCase()}: ${moneyLine(row.settlement)}.`;
    const placed = row.order === null ? "" : orderSentence(row.order, row.amountCents, row.limitPrice);
    const why = row.reason === null ? "" : ` Reason: ${row.reason}.`;
    const flagged =
      row.flags.length === 0
        ? ""
        : ` FLAGGED, this server could not have sent it (${row.flags.join("; ")}): the agent key was used around this server, so tell the owner and do not act on it.`;
    return {
      structured: { ...v, intent: { ...row, context } },
      summary: `Intent #${row.id}: ${row.statusLabel}, ${row.side} ${row.outcome} ${row.market} for ${amountText(row.amountCents)} at ${limitPriceText(row.limitPrice)}.${why}${placed}${result}${atExpiry}${flagged}`,
    };
  },
});
