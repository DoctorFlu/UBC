import { z } from "zod";
import { formatEasternTime } from "./dates";
import { eventKey } from "./events";
import { type Settlement, eventTickerAsset, settlementTotals } from "./settlement";
import type { PolicyEvent } from "./types";

/**
 * Event wake-ups (issue #40): the compact, versioned JSON our backend posts to a Grok Bot routine's
 * webhook when something happens that the owner would want acted on, and the pure rules that decide
 * which chain events and price moves are worth a run. `docs/event-wake.md` explains each choice.
 *
 * The rules only decide; `WakeNotifier` (wake-notifier.ts) owns debounce, the daily cap, retries and
 * the record of what was sent.
 */

export const WAKE_EVENT_TYPE = "mandate.wake";
export const WAKE_EVENT_VERSION = 1;

/**
 * What woke the Bot. The routine (`agent/grok/routine.md`) says what to do for each.
 * - `price_below_floor`: spot fell below the floor of the current goal.
 * - `cover_lost`: spot rose and the protection held no longer meets the goal.
 * - `intent_rejected`: the contract rejected an intent when it was proposed, outside a Bot run.
 * - `owner_decision`: the owner approved or rejected an order that was waiting for them.
 * - `mandate_changed`: the owner changed the rules, paused or resumed the agent.
 * - `order_filled`: the executor recorded a fill well after the order was approved.
 * - `order_failed`: the executor recorded that an approved order did not fill.
 * - `ladder_settled`: every filled position on an expired ladder is settled; the ladder is over.
 */
export const WAKE_KINDS = [
  "price_below_floor",
  "cover_lost",
  "intent_rejected",
  "owner_decision",
  "mandate_changed",
  "order_filled",
  "order_failed",
  "ladder_settled",
] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

const MINUTE_MS = 60_000;

/**
 * Least time between two wake-ups of the same kind. A trigger inside the window is not dropped: it
 * joins the one wake-up of its kind waiting for the window to end (`count` says how many it carries).
 */
export const WAKE_DEBOUNCE_MS: Readonly<Record<WakeKind, number>> = {
  price_below_floor: 30 * MINUTE_MS,
  cover_lost: 30 * MINUTE_MS,
  intent_rejected: 10 * MINUTE_MS,
  owner_decision: 2 * MINUTE_MS,
  mandate_changed: MINUTE_MS,
  order_filled: 10 * MINUTE_MS,
  order_failed: 10 * MINUTE_MS,
  ladder_settled: 10 * MINUTE_MS,
};

/** Wake-ups per UTC day when `GROK_WAKE_DAILY_CAP` is not set: half again the hourly schedule's 24 runs. */
export const WAKE_DEFAULT_DAILY_CAP = 12;

/**
 * A Bot run counts as in progress until this long after the agent's MCP server last called the console.
 * A routine run calls it from its first step (`get_setup_state`) to its last order (`execute_plan` seals
 * each reason there), its tool calls a few seconds apart.
 */
export const RUN_QUIET_MS = 3 * MINUTE_MS;

/**
 * A fill recorded within this many seconds (chain time) of its order's approval is the expected end of
 * that approval, which already woke the Bot or happened inside its run. Only a later fill is news.
 */
export const FILL_GRACE_SECONDS = 120;

/** A chain event older than this when the console first reads it is history, never a wake-up. */
export const MAX_EVENT_AGE_MS = 15 * MINUTE_MS;

/** After spot fell below the floor, it must rise this far above it before another fall counts again. */
export const FLOOR_REARM_BPS = 50;

/** The most intents one wake-up lists; `count` still counts every trigger it carries. */
export const WAKE_MAX_INTENTS = 10;

/** The most ladders one `ladder_settled` wake-up lists. */
export const WAKE_MAX_LADDERS = 4;

/**
 * A ladder whose expiry is older than this when its last settlement is stored wakes nothing. A paused
 * machine wakes within hours (the hourly run calls it), so only a replay is older: settlements recorded
 * again into a new console data folder.
 */
export const SETTLED_NEWS_MS = 24 * 60 * MINUTE_MS;

// ------------------------------------------------------------------ the body

const isoSchema = z.iso.datetime();
const centsSchema = z.int().nonnegative();
const intentRef = { id: z.int().nonnegative(), market: z.string().max(128).nullable() };

const coverStateSchema = z.enum(["met", "partly_met", "not_met", "nothing_to_cover", "cannot_hedge"]);
export type WakeCoverState = z.infer<typeof coverStateSchema>;

/** What each kind reports, beside the fields every wake-up has. */
export const wakeDetailSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price_below_floor"),
    detail: z.object({
      asset: z.string(),
      eventTicker: z.string(),
      planId: z.string(),
      spotCents: centsSchema,
      floorCents: centsSchema,
    }),
  }),
  z.object({
    kind: z.literal("cover_lost"),
    detail: z.object({
      asset: z.string(),
      eventTicker: z.string(),
      planId: z.string(),
      spotCents: centsSchema,
      previousSpotCents: centsSchema,
      state: coverStateSchema,
      /** Cover in basis points (10000 = 100 %), as the server computes it; null when it has no target. */
      coverBps: z.int().nonnegative().nullable(),
    }),
  }),
  z.object({
    kind: z.literal("intent_rejected"),
    detail: z.object({ intents: z.array(z.object({ ...intentRef, reason: z.string().max(200) })).min(1) }),
  }),
  z.object({
    kind: z.literal("owner_decision"),
    detail: z.object({
      intents: z
        .array(
          z.object({
            ...intentRef,
            decision: z.enum(["approved", "rejected"]),
            /** The contract's reason when the decision ended in a rejection, else null. */
            reason: z.string().max(200).nullable(),
          }),
        )
        .min(1),
    }),
  }),
  z.object({
    kind: z.literal("mandate_changed"),
    detail: z.object({ change: z.enum(["paused", "resumed", "rules"]), paused: z.boolean() }),
  }),
  z.object({
    kind: z.literal("order_filled"),
    detail: z.object({
      intents: z
        .array(z.object({ ...intentRef, filledCents: centsSchema.nullable(), pnlCents: z.int().nullable() }))
        .min(1),
    }),
  }),
  z.object({
    kind: z.literal("order_failed"),
    detail: z.object({ intents: z.array(z.object(intentRef)).min(1) }),
  }),
  z.object({
    kind: z.literal("ladder_settled"),
    detail: z.object({
      ladders: z
        .array(
          z.object({
            /** "BTC", read from the event ticker; null when it names no crypto asset. */
            asset: z.string().max(16).nullable(),
            eventTicker: z.string().max(64),
            expiresAt: isoSchema,
            /** The index value the ladder settled at, in dollars as Gemini publishes it, or null. */
            settlementValue: z.string().max(32).nullable(),
            /** Filled positions on the ladder, every one of them settled. */
            positions: z.int().min(1),
            costCents: centsSchema,
            /** Gemini's fees on these fills, estimated from its schedule; absent when none (simulated fills). */
            feeCents: centsSchema.optional(),
            payoutCents: centsSchema,
            /** The net after fees, payout minus cost and fees: negative when the protection expired unused. */
            pnlCents: z.int(),
          }),
        )
        .min(1)
        .max(WAKE_MAX_LADDERS),
    }),
  }),
]);
export type WakeDetail = z.infer<typeof wakeDetailSchema>;
export type WakeDetailOf<K extends WakeKind> = Extract<WakeDetail, { kind: K }>["detail"];

/**
 * The JSON body posted to the routine's webhook, about 300 to 900 bytes. The Bot receives it beside the
 * routine's instruction. `id` is stable across retries, so a receiver can drop a repeat.
 */
export const wakeEventSchema = z
  .object({
    type: z.literal(WAKE_EVENT_TYPE),
    version: z.literal(WAKE_EVENT_VERSION),
    id: z.string().regex(/^wk_[0-9a-f]{24}$/),
    /** When the newest trigger it carries happened (chain time for chain events). */
    occurredAt: isoSchema,
    sentAt: isoSchema,
    /** 1 on the first try, more on a retry of the same wake-up. */
    attempt: z.int().min(1),
    /** Triggers of this kind it carries: more than 1 when several arrived inside the debounce window. */
    count: z.int().min(1),
    /** One plain sentence for the Bot to name the event by. */
    summary: z.string().min(1).max(280),
    /** The console page that shows it, or null when the console's address is not configured. */
    link: z.url().nullable(),
  })
  .and(wakeDetailSchema);
export type WakeEvent = z.infer<typeof wakeEventSchema>;

/** A wake-up as a rule produces it, before the notifier dedupes, debounces and sends it. */
export type WakeCandidate = WakeDetail & {
  /** Identifies the trigger, so the same trigger is never offered twice (exactly once across restarts). */
  sourceId: string;
  /** Unix ms. */
  occurredAt: number;
};

// ------------------------------------------------------------------ summaries

/** Whole dollars without cents ("$80"), anything else with both digits ("$24.80", never "$24.8"). */
const usd = (cents: number) => {
  const digits = cents % 100 === 0 ? 0 : 2;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
};

/** Money with a sign, for a net: "+$27.60", "-$12.40", "$0". */
const signedUsd = (cents: number) => (cents > 0 ? `+${usd(cents)}` : cents < 0 ? `-${usd(-cents)}` : usd(0));

function settledAt(value: string | null): string {
  const dollars = value === null ? Number.NaN : Number(value);
  if (!Number.isFinite(dollars)) return "";
  return ` at $${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function more(count: number, shown: number): string {
  return count > shown ? ` (${String(count)} in all)` : "";
}

/** One sentence naming what happened, written for the Bot to repeat to the owner. */
export function wakeSummary(detail: WakeDetail, count: number): string {
  switch (detail.kind) {
    case "price_below_floor": {
      const d = detail.detail;
      return `${d.asset} spot is ${usd(d.spotCents)}, below the ${usd(d.floorCents)} floor of the current goal.`;
    }
    case "cover_lost": {
      const d = detail.detail;
      const share = d.coverBps === null ? "" : `, ${String(Math.floor(d.coverBps / 100))}% of the goal`;
      return `${d.asset} spot rose from ${usd(d.previousSpotCents)} to ${usd(d.spotCents)} and the goal is no longer covered${share}.`;
    }
    case "intent_rejected": {
      const latest = detail.detail.intents.at(-1);
      const ids = detail.detail.intents.map((i) => `#${String(i.id)}`).join(", ");
      return `The contract rejected intent ${ids}${more(count, detail.detail.intents.length)}: ${latest?.reason ?? "no reason"}.`;
    }
    case "owner_decision": {
      // A rejection for any reason but "rejected by user" is the contract refusing the owner's approval:
      // Policy v2 checks every rule again on approval.
      const parts = detail.detail.intents.map((i) =>
        i.decision === "approved"
          ? `approved #${String(i.id)}`
          : i.reason !== null && i.reason !== "rejected by user"
            ? `approved #${String(i.id)} but the contract refused it (${i.reason})`
            : `rejected #${String(i.id)}`,
      );
      return `The owner ${parts.join(", ")}${more(count, parts.length)}.`;
    }
    case "mandate_changed": {
      const d = detail.detail;
      if (d.change === "paused") return "The owner paused the agent.";
      if (d.change === "resumed") return "The owner resumed the agent.";
      return `The owner changed the rules${d.paused ? "; the agent is paused" : ""}.`;
    }
    case "order_filled": {
      const ids = detail.detail.intents.map((i) => `#${String(i.id)}`).join(", ");
      const latest = detail.detail.intents.at(-1);
      const amount = latest?.filledCents == null ? "" : `, the latest for ${usd(latest.filledCents)}`;
      return `The executor recorded a fill for intent ${ids}${more(count, detail.detail.intents.length)}${amount}.`;
    }
    case "order_failed": {
      const ids = detail.detail.intents.map((i) => `#${String(i.id)}`).join(", ");
      return `The executor recorded that intent ${ids}${more(count, detail.detail.intents.length)} did not fill.`;
    }
    case "ladder_settled": {
      const ladders = detail.detail.ladders;
      const only = ladders.length === 1 ? ladders[0] : undefined;
      if (only) {
        const what = only.positions === 1 ? "1 position" : `${String(only.positions)} positions`;
        const name = only.asset ? `${only.asset} ladder` : "ladder";
        const fee = only.feeCents === undefined ? "" : `, fees ${usd(only.feeCents)} (estimated)`;
        const net = only.feeCents === undefined ? "net" : "net after fees";
        return (
          `The ${name} ${only.eventTicker}, which expired ${formatEasternTime(only.expiresAt)}, settled${settledAt(only.settlementValue)}: ` +
          `${what} cost ${usd(only.costCents)}${fee}, paid ${usd(only.payoutCents)}, ${net} ${signedUsd(only.pnlCents)}. ` +
          "Plan on the next ladder."
        );
      }
      const sum = (key: "costCents" | "feeCents" | "payoutCents" | "pnlCents") =>
        ladders.reduce((total, ladder) => total + (ladder[key] ?? 0), 0);
      const anyFee = ladders.some((ladder) => ladder.feeCents !== undefined);
      return (
        `${String(ladders.length)} ladders settled (${ladders.map((l) => l.eventTicker).join(", ")})${more(count, ladders.length)}: ` +
        `cost ${usd(sum("costCents"))}${anyFee ? `, fees ${usd(sum("feeCents"))} (estimated)` : ""}, ` +
        `paid ${usd(sum("payoutCents"))}, ${anyFee ? "net after fees" : "net"} ${signedUsd(sum("pnlCents"))} in all. ` +
        "Plan on the next ladders."
      );
    }
  }
}

/**
 * Folds a later trigger into a wake-up still waiting to be sent: intents are listed once each (the
 * newest last, at most `WAKE_MAX_INTENTS`), everything else is the later trigger's.
 */
export function mergeWakeDetail(earlier: WakeDetail, later: WakeDetail): WakeDetail {
  if (earlier.kind !== later.kind) return later;
  if (earlier.kind === "ladder_settled" && later.kind === "ladder_settled") {
    const merged = new Map<string, (typeof later.detail.ladders)[number]>();
    for (const ladder of [...earlier.detail.ladders, ...later.detail.ladders]) {
      merged.delete(ladder.eventTicker);
      merged.set(ladder.eventTicker, ladder);
    }
    return { kind: "ladder_settled", detail: { ladders: [...merged.values()].slice(-WAKE_MAX_LADDERS) } };
  }
  if (!("intents" in later.detail) || !("intents" in earlier.detail)) return later;
  type Item = { id: number };
  const merged = new Map<number, Item>();
  for (const item of [...(earlier.detail.intents as Item[]), ...(later.detail.intents as Item[])]) {
    merged.delete(item.id);
    merged.set(item.id, item);
  }
  const intents = [...merged.values()].slice(-WAKE_MAX_INTENTS);
  return { kind: later.kind, detail: { ...later.detail, intents } } as WakeDetail;
}

// ------------------------------------------------------------------ chain events

export interface ChainWakeContext {
  /** The console's deployment id, so the same transaction on a reset devchain is a new trigger. */
  deploymentId: string;
  /** Unix ms. */
  now: number;
  /** Whether a Bot run is in progress (`RUN_QUIET_MS` after the agent's last call to the console). */
  runInProgress: boolean;
  /** True while the console reads a deployment's history for the first time. */
  history: boolean;
}

/**
 * Why an event woke nothing.
 * - `history`: read while catching up on a deployment the console had never read.
 * - `stale`: older than `MAX_EVENT_AGE_MS` when read (the console was stopped or paused meanwhile).
 * - `own_run`: caused by the Bot run in progress, which already has the answer.
 * - `proposal_verdict`: the verdict given in the proposal's own transaction; the proposer has it.
 * - `expected_fill`: a fill within `FILL_GRACE_SECONDS` of its approval.
 * - `no_change`: a pause or resume that left the state as it was.
 * - `same_transaction`: the `Paused` that `setPolicy` emits beside `PolicyUpdated`.
 * - `not_a_trigger`: a proposal, or an order waiting for the owner (the owner acts on those).
 */
export type WakeDropReason =
  | "history"
  | "stale"
  | "own_run"
  | "proposal_verdict"
  | "expected_fill"
  | "no_change"
  | "same_transaction"
  | "not_a_trigger";

export interface ChainWakes {
  wakes: WakeCandidate[];
  dropped: { event: PolicyEvent; reason: WakeDropReason }[];
}

/**
 * Which of `added` (events just stored, in chain order) should wake the Bot. `all` is every event of the
 * deployment in chain order, `added` included: whether an intent waited for the owner, when it was
 * approved and whether the agent was paused before are read from it.
 */
export function chainWakes(
  added: readonly PolicyEvent[],
  all: readonly PolicyEvent[],
  ctx: ChainWakeContext,
): ChainWakes {
  const heldIn = new Map<number, string>();
  const approvedAt = new Map<number, number>();
  const marketOf = new Map<number, string>();
  const rulesTxs = new Set<string>();
  const pausedBefore = new Map<string, boolean>();
  let paused = false;
  for (const event of all) {
    const tx = event.transactionHash.toLowerCase();
    switch (event.type) {
      case "IntentNeedsApproval":
        heldIn.set(event.intentId, tx);
        break;
      case "IntentApproved":
        approvedAt.set(event.intentId, event.blockTimestamp);
        marketOf.set(event.intentId, event.market);
        break;
      case "IntentProposed":
        marketOf.set(event.intentId, event.market);
        break;
      case "PolicyUpdated":
        rulesTxs.add(tx);
        pausedBefore.set(eventKey(event), paused);
        paused = event.rules.paused;
        break;
      case "Paused":
        pausedBefore.set(eventKey(event), paused);
        paused = event.paused;
        break;
      default:
        break;
    }
  }

  const result: ChainWakes = { wakes: [], dropped: [] };
  const drop = (event: PolicyEvent, reason: WakeDropReason) => result.dropped.push({ event, reason });
  const market = (id: number) => (marketOf.get(id) ?? null)?.slice(0, 128) ?? null;

  for (const event of added) {
    if (ctx.history) {
      drop(event, "history");
      continue;
    }
    const occurredAt = event.blockTimestamp * 1000;
    if (ctx.now - occurredAt > MAX_EVENT_AGE_MS) {
      drop(event, "stale");
      continue;
    }
    const tx = event.transactionHash.toLowerCase();
    const sourceId = `chain:${ctx.deploymentId}:${tx}:${String(event.logIndex)}`;
    const wake = (detail: WakeDetail) => result.wakes.push({ ...detail, sourceId, occurredAt });
    const held = (id: number) => heldIn.has(id) && heldIn.get(id) !== tx;

    switch (event.type) {
      case "PolicyUpdated":
        wake({ kind: "mandate_changed", detail: { change: "rules", paused: event.rules.paused } });
        break;
      case "Paused":
        if (rulesTxs.has(tx)) drop(event, "same_transaction");
        else if (pausedBefore.get(eventKey(event)) === event.paused) drop(event, "no_change");
        else {
          wake({
            kind: "mandate_changed",
            detail: { change: event.paused ? "paused" : "resumed", paused: event.paused },
          });
        }
        break;
      case "IntentApproved":
        if (!held(event.intentId)) drop(event, "proposal_verdict");
        else {
          wake({
            kind: "owner_decision",
            detail: {
              intents: [
                { id: event.intentId, market: market(event.intentId), decision: "approved", reason: null },
              ],
            },
          });
        }
        break;
      case "IntentRejected": {
        const reason = event.reason.slice(0, 200);
        if (held(event.intentId)) {
          wake({
            kind: "owner_decision",
            detail: {
              intents: [{ id: event.intentId, market: market(event.intentId), decision: "rejected", reason }],
            },
          });
        } else if (ctx.runInProgress) drop(event, "own_run");
        else {
          wake({
            kind: "intent_rejected",
            detail: { intents: [{ id: event.intentId, market: market(event.intentId), reason }] },
          });
        }
        break;
      }
      case "ResultRecorded": {
        const approved = approvedAt.get(event.intentId);
        const ref = { id: event.intentId, market: market(event.intentId) };
        if (event.filled && approved !== undefined && event.blockTimestamp - approved <= FILL_GRACE_SECONDS) {
          drop(event, "expected_fill");
        } else if (ctx.runInProgress) drop(event, "own_run");
        else if (event.filled) {
          wake({
            kind: "order_filled",
            detail: { intents: [{ ...ref, filledCents: event.filledCents, pnlCents: event.pnlCents }] },
          });
        } else {
          wake({ kind: "order_failed", detail: { intents: [ref] } });
        }
        break;
      }
      case "IntentProposed":
      case "IntentNeedsApproval":
        drop(event, "not_a_trigger");
        break;
    }
  }
  return result;
}

// ------------------------------------------------------------------ price

/** The goal a price check measures: the agent's latest stored plan for one asset. */
export interface PriceGoal {
  planId: string;
  asset: string;
  eventTicker: string;
  floorCents: number;
  /** Spot when the plan was made; a new goal starts on that side of the floor. */
  planSpotCents: number;
}

/** What one price check read: Gemini's spot, and the server's cover computation at that spot. */
export interface PriceReading {
  spotCents: number;
  /** Null when cover could not be measured (no holding saved, or the planner refused the goal). */
  cover: { state: WakeCoverState; coverBps: number | null } | null;
}

/** What the last check of a goal saw, kept across restarts so a crossing wakes the Bot once. */
export interface PriceMemory {
  side: "above" | "below";
  spotCents: number;
  coverState: WakeCoverState | null;
  /** Falls below the floor seen so far; part of each one's `sourceId`. */
  crossings: number;
  /** Losses of cover seen so far; part of each one's `sourceId`. */
  coverLosses: number;
}

export function initialPriceMemory(goal: PriceGoal): PriceMemory {
  return {
    side: goal.planSpotCents < goal.floorCents ? "below" : "above",
    spotCents: goal.planSpotCents,
    coverState: null,
    crossings: 0,
    coverLosses: 0,
  };
}

/**
 * Compares one price check with the last one of the same goal.
 * - Spot below the floor, after being above it: `price_below_floor`. It counts again only once spot has
 *   been back at least `FLOOR_REARM_BPS` above the floor, so a price hovering at the floor wakes once.
 * - Cover met at the last check, not met now, and spot higher than then: `cover_lost`. A loss of cover
 *   that is not a rise of spot (an owner rejection, a failed order) has its own chain trigger.
 * The first check of a goal only remembers what it saw, for cover; for the floor it starts from the side
 * spot was on when the plan was made, so a fall while the console was paused still counts once.
 */
export function priceWakes(
  goal: PriceGoal,
  memory: PriceMemory,
  reading: PriceReading,
  now: number,
): { wakes: WakeCandidate[]; memory: PriceMemory } {
  const wakes: WakeCandidate[] = [];
  const next: PriceMemory = {
    ...memory,
    spotCents: reading.spotCents,
    coverState: reading.cover?.state ?? memory.coverState,
  };
  const base = { asset: goal.asset, eventTicker: goal.eventTicker, planId: goal.planId };

  if (reading.spotCents < goal.floorCents && memory.side === "above") {
    next.side = "below";
    next.crossings = memory.crossings + 1;
    wakes.push({
      kind: "price_below_floor",
      detail: { ...base, spotCents: reading.spotCents, floorCents: goal.floorCents },
      sourceId: `price:${goal.planId}:below:${String(next.crossings)}`,
      occurredAt: now,
    });
  } else if (
    memory.side === "below" &&
    reading.spotCents * 10_000 >= goal.floorCents * (10_000 + FLOOR_REARM_BPS)
  ) {
    next.side = "above";
  }

  const cover = reading.cover;
  if (
    cover !== null &&
    memory.coverState === "met" &&
    (cover.state === "partly_met" || cover.state === "not_met") &&
    reading.spotCents > memory.spotCents
  ) {
    next.coverLosses = memory.coverLosses + 1;
    wakes.push({
      kind: "cover_lost",
      detail: {
        ...base,
        spotCents: reading.spotCents,
        previousSpotCents: memory.spotCents,
        state: cover.state,
        coverBps: cover.coverBps,
      },
      sourceId: `price:${goal.planId}:cover:${String(next.coverLosses)}`,
      occurredAt: now,
    });
  }
  return { wakes, memory: next };
}

// ------------------------------------------------------------------ settlement

/** What the console knows about one ladder when a settlement on it is stored. */
export interface LadderSettlementInput {
  deploymentId: string;
  eventTicker: string;
  /** Ids of every filled buy on the ladder, read from the chain. */
  filledBuys: readonly number[];
  /** The verified settlements stored for the deployment (those of other ladders are ignored). */
  settlements: readonly Settlement[];
  /** Unix ms. */
  now: number;
}

/**
 * One wake-up per ladder (issue #92): once every filled buy on an expired ladder has a verified
 * settlement, the Bot reports what the ladder cost and paid, and plans on the next one. Null while a
 * position on it waits for its outcome, so a ladder of three positions wakes the Bot once, not three
 * times. The trigger id is the deployment and the ladder, so it is offered once across restarts and
 * repeated records. A settlement is never "the run's own doing" or history: the executor records it on
 * its own clock, and a ladder that settled while the console was paused is still news.
 */
export function ladderSettledWake(input: LadderSettlementInput): WakeCandidate | null {
  const docs = input.settlements.filter((doc) => doc.eventTicker === input.eventTicker);
  const first = docs[0];
  if (first === undefined) return null;
  // History, not news: records stored again for a ladder that expired long ago (a deleted data folder).
  if (input.now - Date.parse(first.expiresAt) > SETTLED_NEWS_MS) return null;
  const settled = new Set(docs.map((doc) => doc.intentId));
  if (input.filledBuys.some((id) => !settled.has(id))) return null;
  const totals = settlementTotals(docs);
  return {
    kind: "ladder_settled",
    detail: {
      ladders: [
        {
          asset: eventTickerAsset(input.eventTicker),
          eventTicker: input.eventTicker.slice(0, 64),
          expiresAt: new Date(first.expiresAt).toISOString(),
          settlementValue: first.settlementValue?.slice(0, 32) ?? null,
          positions: totals.positions,
          costCents: totals.costCents,
          ...(totals.feesEstimated ? { feeCents: totals.feeCents } : {}),
          payoutCents: totals.payoutCents,
          pnlCents: totals.pnlCents,
        },
      ],
    },
    sourceId: `settlement:${input.deploymentId}:${input.eventTicker}`,
    occurredAt: input.now,
  };
}
