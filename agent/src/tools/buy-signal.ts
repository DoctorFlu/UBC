import {
  ARC_TESTNET,
  hedgeSignalQuerySchema,
  PROTECTION_VERDICTS,
  SIGNAL_HORIZONS,
  type HedgeSignal,
} from "@mandate/shared";
import { formatUnits } from "viem";
import * as z from "zod";
import {
  reason,
  rejected,
  summarizeVerdict,
  unavailable,
  approved,
  verdictSchema,
  type Verdict,
} from "../mcp/envelope";
import { NotEnoughTime } from "../mcp/deadline";
import { ToolError } from "../mcp/errors";
import { describeIssues, defineTool } from "../mcp/tool";
import { describeFailure, unavailableFor } from "../support/failures";
import type { BudgetState, BuySignalOutcome } from "../x402/payments";
import { SignalSellerError } from "../x402/payments";

const usdc = (baseUnits: bigint) => formatUnits(baseUnits, ARC_TESTNET.usdcDecimals);

const BudgetSchema = z.object({
  dailyUsdc: z.string().describe("Most the signal tool may spend per UTC day, in USDC"),
  spentTodayUsdc: z.string(),
  remainingUsdc: z.string(),
  resetsAt: z.string().describe("When the next day's budget starts (00:00 UTC)"),
});

const StrikeSchema = z.object({
  strikeCents: z
    .number()
    .int()
    .describe("YES wins at or above this price; NO, the protection, pays below it"),
  impliedYesBps: z
    .number()
    .int()
    .nullable()
    .describe(
      "Market-implied chance of finishing at or above the strike (book mid), in basis points; null if a side of the book is empty",
    ),
  modelYesBps: z.number().int().describe("Model chance of finishing at or above the strike, in basis points"),
  noAskCents: z.number().int().nullable().describe("What one NO contract costs now; null if nobody sells NO"),
  edgeCents: z
    .number()
    .int()
    .nullable()
    .describe("Model value of NO minus its price, per contract; positive means protection is cheap"),
  verdict: z.enum(PROTECTION_VERDICTS),
});

const SignalSchema = z.object({
  asset: z.string(),
  eventTicker: z.string(),
  horizon: z.string(),
  expiry: z.string(),
  asOf: z.string(),
  spotCents: z.number().int(),
  realizedVolBps: z.number().int().describe("Annualized realised volatility, in basis points (4500 = 45 %)"),
  realizedVolWindow: z
    .object({
      from: z.string().describe("Open time of the first hourly candle in the window"),
      to: z.string().describe("Close time of the last hourly candle in the window"),
      returns: z.number().int().describe("Hourly returns the estimate rests on"),
      missingHours: z
        .number()
        .int()
        .describe(
          "Hours in the window that Gemini's candle data lacked; they were left out, not filled in, so the estimate rests on fewer returns",
        ),
    })
    .describe("The price history behind realizedVolBps"),
  fairBandBps: z
    .number()
    .int()
    .describe(
      "Edge needed, either way, to call protection cheap or expensive, in basis points of a dollar (100 = 1 cent)",
    ),
  counts: z.object({
    cheap: z.number().int(),
    fair: z.number().int(),
    expensive: z.number().int(),
    noOffer: z.number().int(),
  }),
  strikes: z.array(StrikeSchema).describe("Every strike, lowest first"),
});

const OutputSchema = verdictSchema({
  receiptId: z
    .string()
    .nullable()
    .describe(
      "Payment receipt id (the x402 authorization nonce). Pass it to plan_hedge and cite it as evidence.",
    ),
  signalId: z.string().nullable().describe("Hash of the signal document"),
  priceUsdc: z.string().nullable().describe("What the signal cost, or would have cost"),
  budget: BudgetSchema,
  signal: SignalSchema.nullable(),
  paymentRecorded: z
    .boolean()
    .nullable()
    .describe(
      "The console has this payment on record. False: not yet (the server keeps sending it); null: nothing was paid or no console",
    ),
});
type Output = z.input<typeof OutputSchema>;

export const buySignal = defineTool({
  name: "buy_signal",
  title: "Buy a hedge signal",
  description:
    'Pays a fraction of a cent, from the agent\'s own Circle Gateway balance, for a signal on one Gemini "at or above" ladder: realised volatility, and for each strike the market-implied and model probabilities and whether buying NO (protection) there is cheap, fair or expensive. Call it before planning a hedge. A daily budget applies; when it is used up the result says so and you should plan without a signal. Pick the ladder with one of eventTicker, expiry or horizon (default: horizon weekly). Returns a receiptId to pass to plan_hedge and to cite with the trade.',
  inputSchema: z.object({
    asset: z
      .string()
      .regex(/^[A-Za-z0-9]{2,10}$/)
      .describe("Underlying, for example BTC"),
    eventTicker: z
      .string()
      .optional()
      .describe("Gemini event ticker of the ladder, for example BTC2611202200"),
    expiry: z
      .string()
      .optional()
      .describe("ISO 8601 settlement time of the ladder, for example 2026-11-20T22:00:00Z"),
    horizon: z.enum(SIGNAL_HORIZONS).optional().describe("Soonest open ladder of this kind"),
  }),
  outputSchema: OutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (input, ctx) => {
    const payments = ctx.payments;
    if (payments === undefined) {
      const v = unavailable([reason("NOT_CONFIGURED", "No wallet is configured to pay for signals.")], {
        actor: "owner",
        hint: "Set X402_BUYER_PRIVATE_KEY in the server's .env file and fund its Circle Gateway balance on Arc testnet.",
      });
      return result(v, {
        receiptId: null,
        signalId: null,
        priceUsdc: null,
        budget: emptyBudget(ctx.clock.now()),
        signal: null,
      });
    }

    const picked = [input.eventTicker, input.expiry, input.horizon].filter((value) => value !== undefined);
    const query = hedgeSignalQuerySchema.safeParse({
      asset: input.asset,
      ...(input.eventTicker === undefined ? {} : { eventTicker: input.eventTicker }),
      ...(input.expiry === undefined ? {} : { expiry: input.expiry }),
      ...(picked.length === 0
        ? { horizon: "weekly" }
        : input.horizon === undefined
          ? {}
          : { horizon: input.horizon }),
    });
    if (!query.success) throw new ToolError("INVALID_INPUT", describeIssues(query.error));

    let outcome: BuySignalOutcome;
    try {
      outcome = await payments.buySignal({ query: query.data, at: ctx.clock.now() });
    } catch (error) {
      if (error instanceof SignalSellerError)
        throw new ToolError("UPSTREAM_ERROR", error.message, { cause: error });
      // Stopped before anything was signed (issue #105): nothing was paid and the budget is untouched.
      if (ctx.deadline.stop !== undefined || error instanceof NotEnoughTime) {
        const v = unavailableFor(describeFailure(error, ctx));
        return result(v, {
          receiptId: null,
          signalId: null,
          priceUsdc: null,
          budget: budgetView(payments.budget(ctx.clock.now())),
          signal: null,
        });
      }
      throw error;
    }
    // Best effort and bounded: the console being down never changes the purchase result.
    const reports = ctx.paymentReports;
    let paymentRecorded: boolean | null = null;
    if (outcome.kind === "bought" && reports !== undefined) {
      paymentRecorded = await reports.reportPurchase(outcome.purchase.receiptId);
    } else if (outcome.kind === "payment_unknown" && reports !== undefined) {
      await reports.syncBudget();
    }
    return fromOutcome(outcome, paymentRecorded);
  },
});

function fromOutcome(outcome: BuySignalOutcome, paymentRecorded: boolean | null) {
  const budget = budgetView(outcome.budget);
  const left = `${budget.remainingUsdc} of ${budget.dailyUsdc} USDC left in today's signal budget`;
  switch (outcome.kind) {
    case "bought": {
      const { purchase } = outcome;
      const signal = compact(purchase.signal);
      const v = approved([], {
        actor: "agent",
        hint: `Plan the hedge with signalReceiptId ${purchase.receiptId} so cheap strikes are bought first, and cite that receipt id with the trade.`,
      });
      return result(
        v,
        {
          receiptId: purchase.receiptId,
          signalId: purchase.signal.signalId,
          priceUsdc: purchase.receipt.amountUsdc,
          budget,
          signal,
          paymentRecorded,
        },
        `Bought the ${signal.asset} ${signal.horizon} hedge signal for ${purchase.receipt.amountUsdc} USDC (receipt ${purchase.receiptId}). ${describeSignal(signal)} ${left}.`,
      );
    }
    case "budget_exhausted": {
      const v = rejected(
        [
          reason(
            "SIGNAL_BUDGET_EXHAUSTED",
            `Today's signal budget of ${budget.dailyUsdc} USDC cannot cover ${outcome.price === null ? "another signal" : `a ${usdc(outcome.price)} USDC signal`} (${budget.spentTodayUsdc} USDC spent); it resets at ${budget.resetsAt}.`,
          ),
        ],
        { actor: "agent", hint: "Plan the hedge without a signal. Do not try to buy one again today." },
      );
      return result(v, {
        receiptId: null,
        signalId: null,
        priceUsdc: outcome.price === null ? null : usdc(outcome.price),
        budget,
        signal: null,
      });
    }
    case "price_above_maximum": {
      const v = rejected(
        [
          reason(
            "PRICE_ABOVE_MAXIMUM",
            `The signal costs ${usdc(outcome.price)} USDC, more than the ${usdc(outcome.maxPrice)} USDC this server pays for one signal. Nothing was paid.`,
          ),
        ],
        {
          actor: "agent",
          hint: "Plan the hedge without a signal, and tell the owner the signal price went up.",
        },
      );
      return result(v, {
        receiptId: null,
        signalId: null,
        priceUsdc: usdc(outcome.price),
        budget,
        signal: null,
      });
    }
    case "refused": {
      const code = outcome.code.toUpperCase();
      const v = unavailable([reason(code, `${outcome.message} Nothing was paid.`)], {
        actor: "agent",
        hint:
          outcome.code === "no_ladder" || outcome.code === "expired"
            ? "Ask for another expiry or horizon, or plan without a signal."
            : outcome.code === "invalid_query" || outcome.code === "unknown_asset"
              ? "Check the asset and ladder you asked for, or plan without a signal."
              : "Try again in a minute, or plan without a signal.",
      });
      return result(v, { receiptId: null, signalId: null, priceUsdc: null, budget, signal: null });
    }
    case "payment_rejected": {
      const funding = outcome.reason === "insufficient_balance";
      const v = unavailable(
        [
          reason(
            funding ? "INSUFFICIENT_GATEWAY_BALANCE" : "PAYMENT_REJECTED",
            funding
              ? "The agent's Circle Gateway balance is too low to pay for a signal. Nothing was charged."
              : `Circle Gateway rejected the payment (${outcome.reason}). Nothing was charged.`,
          ),
        ],
        funding
          ? {
              actor: "owner",
              hint: "Deposit testnet USDC into the agent's Circle Gateway balance on Arc (see docs/x402.md).",
            }
          : {
              actor: "agent",
              hint: "Plan the hedge without a signal and tell the owner the payment was rejected.",
            },
      );
      return result(v, { receiptId: null, signalId: null, priceUsdc: null, budget, signal: null });
    }
    case "seller_unreachable": {
      const v = unavailable([reason("SIGNAL_API_UNREACHABLE", `${outcome.message} Nothing was paid.`)], {
        actor: "owner",
        hint: "Start the signal API (npm run signals:start) or fix SIGNALS_URL; meanwhile the agent can plan without a signal.",
      });
      return result(v, { receiptId: null, signalId: null, priceUsdc: null, budget, signal: null });
    }
    case "environment_mismatch": {
      const v = unavailable([reason("MARKET_ENVIRONMENT_MISMATCH", `${outcome.message} Nothing was paid.`)], {
        actor: "owner",
        hint: "Give the signal API the same EXECUTOR_VENUE and GEMINI_ENV as this server; meanwhile plan without a signal.",
      });
      return result(v, { receiptId: null, signalId: null, priceUsdc: null, budget, signal: null });
    }
    case "payment_unknown": {
      const v = unavailable(
        [reason("PAYMENT_OUTCOME_UNKNOWN", `${outcome.message} It counts against today's budget.`)],
        {
          actor: "owner",
          hint: "Check the buyer's Gateway transfers with npm run x402:status; the agent should plan without a signal for now.",
        },
      );
      return result(v, { receiptId: null, signalId: null, priceUsdc: null, budget, signal: null });
    }
  }
}

function result(
  v: Verdict,
  fields: Omit<Output, keyof Verdict | "paymentRecorded"> & { paymentRecorded?: boolean | null },
  summary?: string,
) {
  return {
    structured: { ...v, paymentRecorded: null, ...fields },
    summary: summary ?? `${summarizeVerdict(v)} ${budgetSentence(fields.budget)}`,
  };
}

function budgetSentence(budget: z.input<typeof BudgetSchema>): string {
  return `Signal budget: ${budget.remainingUsdc} of ${budget.dailyUsdc} USDC left today.`;
}

function budgetView(budget: BudgetState): z.input<typeof BudgetSchema> {
  return {
    dailyUsdc: usdc(budget.dailyBudget),
    spentTodayUsdc: usdc(budget.spent),
    remainingUsdc: usdc(budget.remaining),
    resetsAt: budget.resetsAt,
  };
}

function emptyBudget(at: Date): z.input<typeof BudgetSchema> {
  const next = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { dailyUsdc: "0", spentTodayUsdc: "0", remainingUsdc: "0", resetsAt: next.toISOString() };
}

function compact(signal: HedgeSignal): z.input<typeof SignalSchema> {
  return {
    asset: signal.asset,
    eventTicker: signal.eventTicker,
    horizon: signal.horizon,
    expiry: signal.expiry,
    asOf: signal.asOf,
    spotCents: signal.spot.midCents,
    realizedVolBps: signal.volatility.annualizedBps,
    realizedVolWindow: {
      from: signal.volatility.from,
      to: signal.volatility.to,
      returns: signal.volatility.returns,
      // Signals sold before issue #98 have no such field; they only ever used an unbroken run of candles.
      missingHours: signal.volatility.missingHours ?? 0,
    },
    fairBandBps: signal.model.fairBandBps,
    counts: signal.counts,
    strikes: signal.strikes.map((s) => ({
      strikeCents: s.strikeCents,
      impliedYesBps: s.impliedYesBps,
      modelYesBps: s.modelYesBps,
      noAskCents: s.noAskCents,
      edgeCents: s.edgeCents,
      verdict: s.verdict,
    })),
  };
}

/**
 * "Realised volatility 59.09 % a year from 168 hourly returns to 2026-11-15T20:00:00.000Z. Protection is
 * cheap at $61,500 to $64,000 (best +3c at $63,000) and expensive at 11 strikes from $66,000."
 */
function describeSignal(signal: z.input<typeof SignalSchema>): string {
  const window = signal.realizedVolWindow;
  const gap =
    window.missingHours === 0
      ? ""
      : ` (Gemini's candles lacked ${window.missingHours} hours of the window; they were left out, not filled in)`;
  const vol = `Realised volatility ${Math.floor(signal.realizedVolBps / 100)}.${(signal.realizedVolBps % 100).toString().padStart(2, "0")} % a year from ${window.returns} hourly returns to ${window.to}${gap}.`;
  const cheap = signal.strikes.filter((s) => s.verdict === "cheap");
  const expensive = signal.strikes.filter((s) => s.verdict === "expensive");
  const parts: string[] = [];
  if (cheap.length > 0) {
    const best = cheap.reduce((a, b) => ((b.edgeCents ?? 0) > (a.edgeCents ?? 0) ? b : a));
    parts.push(
      `cheap at ${strikesText(cheap.map((s) => s.strikeCents))} (best +${best.edgeCents ?? 0}c at ${dollars(best.strikeCents)})`,
    );
  }
  if (expensive.length > 0) parts.push(`expensive at ${strikesText(expensive.map((s) => s.strikeCents))}`);
  const fair = signal.counts.fair;
  const tail =
    parts.length === 0
      ? "Protection is fairly priced at every strike."
      : `Protection is ${parts.join(" and ")}; ${fair} fair.`;
  return `${vol} ${tail}`;
}

function strikesText(strikes: number[]): string {
  if (strikes.length <= 3) return strikes.map(dollars).join(", ");
  return `${strikes.length} strikes from ${dollars(Math.min(...strikes))} to ${dollars(Math.max(...strikes))}`;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  return cents % 100 === 0 ? `$${whole}` : `$${whole}.${(cents % 100).toString().padStart(2, "0")}`;
}
