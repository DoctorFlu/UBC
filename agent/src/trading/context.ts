/**
 * Sealed decision contexts (issue #33): the document that records why the agent proposed an
 * intent. Its hash goes onchain with the intent when the contract supports it, and the document
 * goes to the console, so anyone can later check it was not rewritten.
 */
import type { Ladder, MarketEvent } from "@mandate/gemini";
import { formatPrice } from "@mandate/planner";
import { hashContext, type DecisionContext, type LadderSummary } from "@mandate/shared";
import { ConsoleClientError } from "../console/client";
import type { ToolContext } from "../context";
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
