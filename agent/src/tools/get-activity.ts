import * as z from "zod";
import { formatUnits } from "viem";
import {
  ARC_TESTNET,
  formatCents,
  type Intent,
  type IntentView,
  type StoredSettlement,
  type SummaryResponse,
} from "@mandate/shared";
import type { ToolContext } from "../context";
import { ok, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { untrusted, UntrustedTextSchema } from "../mcp/untrusted";
import type { AgentPolicy } from "../services";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { intentFlags, intentRow, IntentRowSchema, shownMarket } from "../support/intents";
import { proposedChangesText, reasonCode } from "../support/rules";
import { readOrders } from "../support/orders";
import {
  LadderSettlementSchema,
  ladderSentence,
  moneyLine,
  readSettlements,
  settledLadders,
  SettlementTotalsSchema,
  totalsRow,
} from "../support/settlements";
import { consoleLink, readSummary } from "../support/summary";

const DAY_MS = 86_400_000;
/** Most intents read to sum a day; a busier day is reported as incomplete, never guessed. */
const MAX_DAY_INTENTS = 60;
/** Intents read in parallel while walking back through the day. */
const READ_BATCH = 10;
const MAX_WAITING_INTENTS = 3;
const MAX_WAITING_REQUESTS = 2;
const MAX_DAY_LADDERS = 2;
/** A change request's reason is for the console; the result carries only its start. */
const MAX_REASON_LENGTH = 60;

const DaySchema = z
  .object({
    from: z.string(),
    to: z.string(),
    complete: z
      .boolean()
      .describe(
        "false when more intents were proposed in the window than this tool reads; the sums cover the newest",
      ),
    proposed: z.int().describe("Intents proposed in the window"),
    executed: z.int(),
    approved: z.int().describe("Approved, waiting for the executor"),
    needsApproval: z.int().describe("Waiting for the owner"),
    rejected: z.int(),
    failed: z.int(),
    filledCents: z
      .int()
      .describe("What the intents proposed in the window have filled so far: spent on protection"),
    awaitingFillCents: z.int().describe("Approved and not filled yet"),
    awaitingOwnerCents: z.int().describe("Waiting for the owner's approval"),
    rejections: z
      .array(z.object({ reasonCode: z.string(), reason: z.string(), count: z.int() }))
      .describe("Rejected intents by the contract's reason"),
    flagged: z
      .array(z.int())
      .describe("Intents in the window that could not have come from this server: tell the owner"),
    signals: z
      .object({ bought: z.int(), spentUsdc: z.string().describe("USDC, a decimal string") })
      .nullable()
      .describe(
        "Hedge signals this server paid for in the window. null when this server pays for no signals",
      ),
    settled: SettlementTotalsSchema.extend({
      ladders: z.array(LadderSettlementSchema).describe("At most 2, the latest expiry first"),
    })
      .nullable()
      .describe(
        "Positions whose settlement the console stored in the window: cost, payout and net. null when the console cannot say",
      ),
  })
  .describe("The last 24 hours, summed by the server. Report these numbers; never add up intents yourself");

const WaitingSchema = z
  .object({
    link: z
      .string()
      .nullable()
      .describe(
        "The console's Approvals page, where the owner decides all of these. null when the console cannot say",
      ),
    complete: z
      .boolean()
      .describe("false when older intents could not be checked: approvals older than the list may also wait"),
    intents: z
      .array(
        z.object({
          id: z.int(),
          market: z.string(),
          amountCents: z.int().nullable(),
        }),
      )
      .describe("Intents waiting for the owner's approval, newest first, at most 3"),
    moreIntents: z.int().describe("Waiting intents beyond the list"),
    changeRequests: z
      .array(
        z.object({
          id: z.string(),
          changes: z.string().describe("What it asks for, in this server's words"),
          reason: UntrustedTextSchema.describe("Why, as the agent wrote it; the start only"),
        }),
      )
      .nullable()
      .describe(
        "Rule change requests waiting for the owner, newest first, at most 2. null when the console cannot say",
      ),
    moreChangeRequests: z.int(),
  })
  .describe("Everything waiting for the owner now, however old");

/** A note on intents older than the list that still matter, or "". */
function olderIntents(waiting: number, rejected: number): string {
  const parts = [
    ...(waiting > 0 ? [`${waiting} waiting for approval`] : []),
    ...(rejected > 0 ? [`${rejected} rejected`] : []),
  ];
  return parts.length === 0 ? "" : ` Older intents: ${parts.join(", ")}.`;
}

/**
 * The newest intents, from storage: at least `limit`, and back through the window's start, at most
 * `MAX_DAY_INTENTS` past `limit`. Ids grow with time, so the walk stops at the first intent older than
 * the window. `complete` says whether the walk reached the window's start.
 */
async function readNewest(
  policy: AgentPolicy,
  total: number,
  limit: number,
  fromSeconds: number,
): Promise<{ intents: Intent[]; complete: boolean; all: boolean }> {
  const intents: Intent[] = [];
  let next = total - 1;
  while (next >= 0) {
    const oldest = intents.at(-1);
    if (intents.length >= limit && oldest !== undefined && oldest.proposedAt < fromSeconds) break;
    if (intents.length >= Math.max(limit, MAX_DAY_INTENTS)) break;
    const ids = Array.from({ length: Math.min(READ_BATCH, next + 1) }, (_, i) => next - i);
    const read = await Promise.all(ids.map((id) => policy.intent(id)));
    intents.push(...read.filter((intent): intent is Intent => intent !== null));
    next -= ids.length;
  }
  const oldest = intents.at(-1);
  return {
    intents,
    complete: next < 0 || (oldest !== undefined && oldest.proposedAt < fromSeconds),
    all: next < 0,
  };
}

function summedDay(
  ctx: ToolContext,
  window: { from: Date; to: Date; complete: boolean },
  inWindow: readonly Intent[],
  views: ReadonlyMap<number, IntentView>,
  stored: readonly StoredSettlement[] | null,
): z.infer<typeof DaySchema> {
  const count = (status: string) => inWindow.filter((intent) => intent.status === status).length;
  const sum = (status: string, field: "amountCents" | "filledCents") =>
    inWindow
      .filter((intent) => intent.status === status)
      .reduce((total, intent) => total + (intent[field] ?? 0), 0);
  const rejections = new Map<string, number>();
  for (const intent of inWindow.filter((candidate) => candidate.status === "rejected")) {
    const reason = views.get(intent.id)?.reason ?? "reason unknown";
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  }
  const fromMs = window.from.getTime();
  const payments = ctx.payments;
  const paid = payments?.paidSignals().filter((entry) => Date.parse(entry.paidAt) >= fromMs) ?? null;
  const settledNow = stored?.filter((settlement) => Date.parse(settlement.storedAt) >= fromMs) ?? null;
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    complete: window.complete,
    proposed: inWindow.length,
    executed: count("executed"),
    approved: count("approved"),
    needsApproval: count("needs_approval"),
    rejected: count("rejected"),
    failed: count("failed"),
    filledCents: sum("executed", "filledCents"),
    awaitingFillCents: sum("approved", "amountCents"),
    awaitingOwnerCents: sum("needs_approval", "amountCents"),
    rejections: [...rejections].map(([reason, n]) => ({ reasonCode: reasonCode(reason), reason, count: n })),
    flagged: inWindow.filter((intent) => intentFlags(intent).length > 0).map((intent) => intent.id),
    signals:
      paid === null
        ? null
        : {
            bought: paid.length,
            spentUsdc: formatUnits(
              paid.reduce((total, entry) => total + entry.amount, 0n),
              ARC_TESTNET.usdcDecimals,
            ),
          },
    settled:
      settledNow === null
        ? null
        : {
            ...totalsRow(settledNow.map((settlement) => settlement.document)),
            ladders: settledLadders(settledNow).slice(0, MAX_DAY_LADDERS),
          },
  };
}

function dayText(day: z.infer<typeof DaySchema>, hasConsole: boolean): string {
  const parts = [
    ...(day.executed > 0 ? [`${day.executed} executed (${formatCents(day.filledCents)} filled)`] : []),
    ...(day.approved > 0
      ? [`${day.approved} approved and waiting for the executor (${formatCents(day.awaitingFillCents)})`]
      : []),
    ...(day.needsApproval > 0
      ? [`${day.needsApproval} waiting for the owner (${formatCents(day.awaitingOwnerCents)})`]
      : []),
    ...(day.rejected > 0
      ? [
          `${day.rejected} rejected (${day.rejections.map((r) => `${r.reason}${r.count > 1 ? ` x${r.count}` : ""}`).join("; ")})`,
        ]
      : []),
    ...(day.failed > 0 ? [`${day.failed} failed`] : []),
  ];
  const intents =
    day.proposed === 0
      ? "no intents proposed"
      : `${day.proposed} ${day.proposed === 1 ? "intent" : "intents"} proposed: ${parts.join(", ")}`;
  const partial = day.complete ? "" : ` Only the newest ${day.proposed} intents of the window were read.`;
  const flagged =
    day.flagged.length === 0
      ? ""
      : ` FLAGGED in the window: ${day.flagged.map((id) => `#${id}`).join(", ")} could not have come from this server; tell the owner.`;
  const signals =
    day.signals === null
      ? ""
      : day.signals.bought === 0
        ? " No signals bought."
        : ` ${day.signals.bought} ${day.signals.bought === 1 ? "signal" : "signals"} bought for ${day.signals.spentUsdc} USDC.`;
  const settled =
    day.settled === null
      ? hasConsole
        ? " Settlements: the console cannot say right now."
        : ""
      : day.settled.positions === 0
        ? " Nothing settled."
        : day.settled.ladders.length === 1 && day.settled.ladders[0] !== undefined
          ? ` Settled: ${ladderSentence(day.settled.ladders[0])}`
          : ` Settled: ${day.settled.positions} positions, ${moneyLine(day.settled)}; latest ladders ${day.settled.ladders.map((ladder) => ladder.eventTicker).join(", ")}.`;
  return `Last 24 hours: ${intents}.${partial}${flagged}${signals}${settled}`;
}

function waitingFor(
  waitingIds: readonly number[],
  byId: ReadonlyMap<number, Intent>,
  views: ReadonlyMap<number, IntentView>,
  summary: SummaryResponse | null,
  complete: boolean,
): z.infer<typeof WaitingSchema> {
  const shown = waitingIds.slice(0, MAX_WAITING_INTENTS).map((id) => {
    const intent = byId.get(id);
    const view = views.get(id);
    const market = intent?.market ?? view?.market ?? null;
    return {
      id,
      market: market === null ? "(unknown)" : shownMarket(market),
      amountCents: intent === undefined ? (view?.amountCents ?? null) : intent.amountCents,
    };
  });
  const requests = summary?.changeRequests ?? null;
  return {
    link: summary === null ? null : consoleLink(summary, "/approvals"),
    complete,
    intents: shown,
    moreIntents: waitingIds.length - shown.length,
    changeRequests:
      requests === null
        ? null
        : requests.slice(0, MAX_WAITING_REQUESTS).map((request) => ({
            id: request.id,
            changes: proposedChangesText(request.proposed),
            reason: untrusted(request.reason, "agent", MAX_REASON_LENGTH),
          })),
    moreChangeRequests: requests === null ? 0 : Math.max(0, requests.length - MAX_WAITING_REQUESTS),
  };
}

function waitingText(waiting: z.infer<typeof WaitingSchema>, hasConsole: boolean): string {
  const intents = waiting.intents.map(
    (intent) =>
      `intent #${intent.id}${intent.amountCents === null ? "" : ` (${formatCents(intent.amountCents)})`}`,
  );
  if (waiting.moreIntents > 0) intents.push(`${waiting.moreIntents} more intents`);
  const requests = (waiting.changeRequests ?? []).map(
    (request) => `change request ${request.id} (${request.changes})`,
  );
  if (waiting.moreChangeRequests > 0) requests.push(`${waiting.moreChangeRequests} more change requests`);
  const unknown =
    waiting.changeRequests === null && hasConsole
      ? " Change requests: the console cannot say right now."
      : "";
  const older = waiting.complete
    ? ""
    : " Older intents could not be checked, so other approvals may also wait.";
  const items = [...intents, ...requests];
  if (items.length === 0) {
    return waiting.changeRequests === null || !waiting.complete
      ? `${unknown}${older}`
      : " Nothing waits for the owner.";
  }
  return ` Waiting for the owner: ${items.join("; ")}.${waiting.link === null ? "" : ` Approvals: ${waiting.link}`}${unknown}${older}`;
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
    last24h: DaySchema.nullable(),
    waitingForOwner: WaitingSchema.nullable(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const empty = {
      total: null,
      intents: null,
      truncated: false,
      settlements: null,
      last24h: null,
      waitingForOwner: null,
    };
    if (ctx.policy === undefined) {
      const v = unavailableFor(notConfigured.policy());
      return { structured: { ...v, ...empty }, summary: summarizeVerdict(v) };
    }
    const policy = ctx.policy;
    const to = ctx.clock.now();
    const from = new Date(to.getTime() - DAY_MS);
    const fromSeconds = Math.floor(from.getTime() / 1000);
    let total: number;
    let newest: { intents: Intent[]; complete: boolean; all: boolean };
    try {
      total = await policy.intentCount();
      newest = await readNewest(policy, total, input.limit, fromSeconds);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, ...empty }, summary: summarizeVerdict(v) };
    }
    const intents = newest.intents.slice(0, input.limit);
    // Rejection reasons live only in events. A failed scan still leaves a useful list.
    const events = await policy.intentEvents().then(
      (views) => ({ views, read: true }),
      (error: unknown) => {
        describeFailure(error, ctx);
        return { views: new Map<number, IntentView>(), read: false };
      },
    );
    const views: ReadonlyMap<number, IntentView> = events.views;
    const eventsRead = events.read;
    // What filled positions paid at expiry lives in the console, signed by the executor (issue #92); the
    // links and the change requests waiting for the owner too (issue #97), and the size of each order the
    // executor placed on Gemini (issue #117).
    const [stored, summary, orders] = await Promise.all([
      readSettlements(ctx),
      readSummary(ctx),
      readOrders(ctx),
    ]);
    const byIntent = new Map(stored?.map((settlement) => [settlement.intentId, settlement.document]));
    const rows = intents.map((intent) =>
      intentRow(
        intent,
        views.get(intent.id),
        ctx.ledger.lookup(intent.id),
        byIntent.get(intent.id),
        orders?.get(intent.id),
      ),
    );
    const ladders = stored === null ? null : settledLadders(stored);
    const settlements =
      stored === null || ladders === null
        ? null
        : {
            ...totalsRow(stored.map((settlement) => settlement.document)),
            ladders: ladders.slice(0, 5),
          };

    const inWindow = newest.intents.filter((intent) => intent.proposedAt >= fromSeconds);
    const last24h = summedDay(ctx, { from, to, complete: newest.complete }, inWindow, views, stored);
    // Storage is authoritative for what it read; the events cover every intent, so an approval still
    // waiting further back is not missed.
    const byId = new Map(newest.intents.map((intent) => [intent.id, intent]));
    const waitingIds = [
      ...newest.intents.filter((intent) => intent.status === "needs_approval").map((intent) => intent.id),
      ...[...views.values()]
        .filter((view) => view.status === "needs_approval" && !byId.has(view.id))
        .map((view) => view.id),
    ].sort((a, b) => b - a);
    // Approvals older than the intents read are found through the events; without them they are unknown.
    const waitingForOwner = waitingFor(waitingIds, byId, views, summary, eventsRead || newest.all);

    const count = (status: string) => rows.filter((r) => r.status === status).length;
    const v = ok(
      [],
      waitingIds.length > 0
        ? {
            actor: "owner",
            hint: `Intents ${waitingIds.map((id) => `#${id}`).join(", ")} wait for the owner's approval in the console.`,
          }
        : ladders !== null && ladders.length > 0
          ? {
              actor: "agent",
              hint: "Report these results to the owner in plain words, including what each expired ladder cost, paid and netted. An expired ladder is over: plan any new protection on the next ladder.",
            }
          : { actor: "agent", hint: "Report these results to the owner in plain words." },
    );
    const olderRejected = [...views.values()].filter(
      (view) => view.status === "rejected" && !rows.some((r) => r.id === view.id),
    ).length;
    const rejectedRows = rows.filter((r) => r.status === "rejected");
    const reasons = [...new Set(rejectedRows.map((r) => r.reason ?? "reason unknown"))];
    const filled = rows.reduce((sum, r) => sum + (r.filledCents ?? 0), 0);
    const flagged = rows.filter((r) => r.flags.length > 0).map((r) => `#${r.id}`);
    const flaggedText =
      flagged.length === 0
        ? ""
        : ` FLAGGED: ${flagged.join(", ")} could not have come from this server (see flags); the agent key was used around it, so tell the owner.`;
    const settledToday = new Set(last24h.settled?.ladders.map((ladder) => ladder.eventTicker));
    const settledText =
      ladders === null
        ? ctx.console === undefined
          ? ""
          : " Settlements: the console cannot say right now, so do not report any payout."
        : ladders.length === 0
          ? ""
          : ` ${ladders
              .slice(0, 3)
              // A ladder settled today is in the day's sentence below; say it once.
              .filter((ladder) => !settledToday.has(ladder.eventTicker))
              .map((ladder) => ladderSentence(ladder))
              .join(" ")}`;
    const latest =
      total === 0
        ? "No intents have been proposed on this contract yet."
        : `Latest ${rows.length} of ${total} intents: ${count("approved")} approved and waiting for the executor, ${count("executed")} executed (${formatCents(filled)} filled), ${count("failed")} failed, ${count("needs_approval")} waiting for approval, ${rejectedRows.length} rejected${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}.${olderIntents(waitingIds.filter((id) => !rows.some((r) => r.id === id)).length, olderRejected)}${settledText}${flaggedText}`;
    return {
      structured: {
        ...v,
        total,
        intents: rows,
        truncated: total > rows.length,
        settlements,
        last24h,
        waitingForOwner,
      },
      summary: `${latest} ${dayText(last24h, ctx.console !== undefined)}${waitingText(waitingForOwner, ctx.console !== undefined)}`,
    };
  },
});
