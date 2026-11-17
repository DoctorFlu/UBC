/**
 * Sealed decision contexts (issue #33): the document that records why the agent proposed an
 * intent. Its hash goes onchain with the intent when the contract supports it, and the document
 * goes to the console, so anyone can later check it was not rewritten. Once the intent exists, the
 * console is also told which document explains it, because the production contract records no hash.
 */
import type { Ladder, MarketEvent } from "@mandate/gemini";
import { formatPrice } from "@mandate/planner";
import { hashContext, raceAbort, type DecisionContext, type LadderSummary } from "@mandate/shared";
import { ConsoleClientError } from "../console/client";
import type { ToolContext } from "../context";
import { scrubText } from "../logger";
import type { ContextLink } from "../state/ledger";
import { describeFailure } from "../support/failures";

/** Rungs kept in a document. A ladder has about 20; this only bounds a pathological event. */
const MAX_SUMMARY_RUNGS = 60;

/** The plan id recorded for a trade proposed directly with `propose_trade`, not from a plan. */
export const DIRECT_PLAN_ID = "direct";

export function ladderSummaryFromLadder(ladder: Ladder): LadderSummary {
  return {
    eventTicker: ladder.eventTicker,
    observedAt: ladder.fetchedAt,
    rungs: ladder.rungs.slice(0, MAX_SUMMARY_RUNGS).map((rung) => ({
      instrumentSymbol: rung.instrumentSymbol,
      label: rung.label ?? `${ladder.asset} at or above ${formatPrice(rung.strikeCents)}`,
      yesBidCents: rung.yesBidCents,
      yesAskCents: rung.yesAskCents,
    })),
  };
}

export function ladderSummaryFromEvent(event: MarketEvent, observedAt: string): LadderSummary {
  return {
    eventTicker: event.ticker,
    observedAt,
    rungs: event.contracts.slice(0, MAX_SUMMARY_RUNGS).map((contract) => ({
      instrumentSymbol: contract.instrumentSymbol,
      label: contract.label ?? contract.ticker ?? contract.instrumentSymbol,
      yesBidCents: contract.quote.yesBidCents,
      yesAskCents: contract.quote.yesAskCents,
    })),
  };
}

export interface SealedContext {
  hash: `0x${string}`;
  document: DecisionContext;
  /** Whether the console has the document now. If not, it is queued and retried later. */
  stored: boolean;
}

/**
 * Hashes the document and stores it in the console under its hash before the intent is proposed,
 * so the console can show the reason as soon as the intent appears. When the console is not
 * configured or does not answer, the document is queued in this process and retried on the next
 * proposal; the proposal goes ahead either way, with the hash.
 */
export async function sealContext(
  ctx: ToolContext,
  fields: Omit<DecisionContext, "version" | "createdAt">,
): Promise<SealedContext> {
  const document: DecisionContext = { version: 1, ...fields, createdAt: ctx.clock.now().toISOString() };
  const hash = hashContext(document);
  ctx.ledger.queueContext(hash, document);
  await flushContexts(ctx);
  const stored = !ctx.ledger.pendingContexts().some(([pending]) => pending === hash);
  return { hash, document, stored };
}

/** Sends every queued document to the console, oldest first, stopping at the first failure. */
export async function flushContexts(ctx: ToolContext): Promise<void> {
  const consoleClient = ctx.console;
  if (consoleClient === undefined) return;
  for (const [hash, document] of ctx.ledger.pendingContexts()) {
    try {
      await consoleClient.putContext(hash, document, ctx.signal);
      ctx.ledger.contextStored(hash);
    } catch (error) {
      describeFailure(error, ctx);
      // A document the console refuses (422) will never be accepted; keep it from blocking the rest.
      if (error instanceof ConsoleClientError && error.kind === "rejected") {
        ctx.logger.error("context.refused_by_console", { code: error.code ?? "unknown" });
        ctx.ledger.dropContext(hash);
        continue;
      }
      return;
    }
  }
}

/** Most one attempt to link an intent may take. The verdict waits for it, so it stays short. */
export const LINK_TIMEOUT_MS = 3_000;
/** Pause before the one retry of a link the console did not answer. */
export const LINK_RETRY_DELAY_MS = 200;

/**
 * Tells the console which decision context explains an intent (`PUT intents/<id>/context`), so it can
 * show why the agent acted even when the contract records no hash. Best effort, and never throws:
 * each attempt is bounded by `LINK_TIMEOUT_MS`, an unanswered attempt is retried once, and a link the
 * console could not take stays in the ledger's outbox for a later proposal or a replayed call.
 * With `attempt: false` the link is only queued (the console just failed on an earlier order).
 *
 * Returns true when the console has the link, false when it does not (yet), null without a console.
 */
export async function linkContext(
  ctx: ToolContext,
  intentId: number,
  link: ContextLink,
  options: { attempt?: boolean } = {},
): Promise<boolean | null> {
  if (ctx.console === undefined) return null;
  ctx.ledger.queueLink(intentId, link);
  if (options.attempt === false) return false;
  const linked = await deliverLink(ctx, intentId, link);
  // The console answers again: send the links that earlier proposals could not.
  if (linked) await flushLinks(ctx);
  return linked;
}

/**
 * Tries again to link an intent whose link is still queued, for a replayed call. Returns the
 * intent's link state, or `fallback` when the ledger no longer knows the intent.
 */
export async function relinkContext(
  ctx: ToolContext,
  intentId: number,
  fallback: boolean | null,
): Promise<boolean | null> {
  if (ctx.console === undefined) return null;
  const pending = ctx.ledger.pendingLink(intentId);
  if (pending === undefined) return ctx.ledger.lookup(intentId)?.contextLinked ?? fallback;
  return deliverLink(ctx, intentId, pending);
}

/** True when the intent's link waits in the outbox because the console did not take it yet. */
export function linkPending(ctx: ToolContext, intentId: number): boolean {
  return ctx.ledger.pendingLink(intentId) !== undefined;
}

/** Sends queued links, oldest first, stopping at the first the console cannot take now. */
async function flushLinks(ctx: ToolContext): Promise<void> {
  for (const [intentId, link] of ctx.ledger.pendingLinks()) {
    const linked = await deliverLink(ctx, intentId, link);
    if (!linked && linkPending(ctx, intentId)) return;
  }
}

async function deliverLink(ctx: ToolContext, intentId: number, link: ContextLink): Promise<boolean> {
  const consoleClient = ctx.console;
  if (consoleClient === undefined) return false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await consoleClient.putIntentContext(
        intentId,
        link,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(LINK_TIMEOUT_MS)]),
      );
      ctx.ledger.settleLink(intentId, true);
      ctx.logger.info("intent.context_linked", { intentId, attempts: attempt });
      return true;
    } catch (error) {
      // The call was stopped (deadline or client gone), not refused: the link stays queued.
      if (ctx.signal.aborted) {
        ctx.logger.debug("intent.context_link_deferred", { intentId, attempts: attempt });
        return false;
      }
      const kind = error instanceof ConsoleClientError ? error.kind : "invalid";
      if (kind === "unreachable" && attempt === 1) {
        await raceAbort(new Promise((resolve) => setTimeout(resolve, LINK_RETRY_DELAY_MS)), ctx.signal).catch(
          () => undefined,
        );
        continue;
      }
      // A conflict or a refused body will never be accepted; anything else may be, later.
      const final = kind === "conflict" || kind === "rejected" || kind === "invalid";
      const fields = {
        intentId,
        kind,
        status: error instanceof ConsoleClientError ? (error.status ?? null) : null,
        code: error instanceof ConsoleClientError ? (error.code ?? null) : null,
        message: error instanceof Error ? scrubText(error.message).slice(0, 300) : "",
        attempts: attempt,
        willRetry: !final,
      };
      if (final) {
        ctx.logger.error("intent.context_link_failed", fields);
        ctx.ledger.settleLink(intentId, false);
      } else {
        ctx.logger.warn("intent.context_link_failed", fields);
      }
      return false;
    }
  }
}
