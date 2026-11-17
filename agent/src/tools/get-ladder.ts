import * as z from "zod";
import { LADDER_KINDS, type Ladder, type LadderRung } from "@mandate/gemini";
import { formatExpiry, formatPrice } from "@mandate/planner";
import { Category, isCategoryAllowed } from "@mandate/shared";
import { ok, reason, summarizeVerdict, verdictSchema, type Reason } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { untrusted, UntrustedTextSchema } from "../mcp/untrusted";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { NO_PRICES_HINT, noPricesReason, pricedRungCount } from "../support/no-prices";

const MAX_RUNGS = 25;
const MAX_OTHER_LADDERS = 8;

export const assetArg = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,10}$/)
  .describe("Crypto asset symbol, e.g. BTC, ETH, SOL");

const RungSchema = z.object({
  strikeCents: z.int().describe("YES wins at or above this price at expiry; NO wins below it"),
  instrumentSymbol: z.string(),
  marketState: z.string().nullable(),
  noBuyCents: z.int().nullable().describe("Price to buy one NO contract now (the hedge side)"),
  yesBidCents: z.int().nullable(),
  yesAskCents: z.int().nullable(),
});

const LadderViewSchema = z.object({
  eventTicker: z.string(),
  title: UntrustedTextSchema,
  asset: z.string(),
  kind: z.string().describe("hourly, daily, weekly or month-end"),
  expiry: z.string(),
  spotCents: z.int().describe("Gemini spot mid price; the ladder settles on settlementIndex"),
  settlementIndex: z.string().nullable(),
  rungCount: z.int(),
  pricedRungCount: z
    .int()
    .describe("Strikes someone sells NO on now; 0 means nothing can be planned or filled on this ladder"),
  marketEnvironment: z
    .enum(["sandbox", "production"])
    .describe("Which Gemini these prices come from: the sandbox when the executor trades there"),
  rungs: z.array(RungSchema).describe("The strikes nearest spot, lowest first"),
  truncated: z.boolean(),
  otherLadders: z.array(z.object({ eventTicker: z.string(), kind: z.string(), expiry: z.string() })),
});

/** The `max` rungs closest to spot, kept in strike order. */
export function rungsNearSpot(rungs: readonly LadderRung[], spotCents: number, max: number): LadderRung[] {
  if (rungs.length <= max) return [...rungs];
  const nearest = [...rungs]
    .sort((a, b) => Math.abs(a.strikeCents - spotCents) - Math.abs(b.strikeCents - spotCents))
    .slice(0, max);
  return nearest.sort((a, b) => a.strikeCents - b.strikeCents);
}

export const getLadder = defineTool({
  name: "get_ladder",
  title: "Read a strike ladder",
  description:
    "Returns a Gemini crypto strike ladder: 'at or above K' contracts for one asset and expiry, with the price to buy NO at each strike (the hedge side) and the spot price. Pick the ladder by horizon (hourly, daily, weekly, month-end; default weekly) or by eventTicker. Call it before plan_hedge.",
  inputSchema: z.object({
    asset: assetArg,
    horizon: z.enum(LADDER_KINDS).default("weekly").describe("Soonest open ladder of this kind"),
    eventTicker: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,80}$/)
      .optional()
      .describe("A specific ladder event, overriding horizon"),
  }),
  outputSchema: verdictSchema({ ladder: LadderViewSchema.nullable() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.markets === undefined) {
      const v = unavailableFor(notConfigured.markets());
      return { structured: { ...v, ladder: null }, summary: summarizeVerdict(v) };
    }
    const asset = input.asset.toUpperCase();
    let ladder: Ladder;
    let others;
    try {
      [ladder, others] = await Promise.all([
        ctx.markets.getLadder({
          asset,
          ...(input.eventTicker === undefined
            ? { horizon: input.horizon }
            : { eventTicker: input.eventTicker }),
        }),
        ctx.markets.listLadders(asset),
      ]);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, ladder: null }, summary: summarizeVerdict(v) };
    }

    const reasons: Reason[] = [];
    if (ctx.policy !== undefined) {
      const rules = await ctx.policy
        .snapshot()
        .then((s) => s.rules)
        .catch(() => undefined);
      if (rules !== undefined && !isCategoryAllowed(rules.allowedCategories, Category.Crypto)) {
        reasons.push(
          reason(
            "CATEGORY_NOT_ALLOWED",
            "The mandate does not allow Crypto markets, so this ladder cannot be traded.",
          ),
        );
      }
    }
    const environment = ctx.config.marketData.environment;
    const noPrices = noPricesReason(ladder, environment);
    if (noPrices !== null) reasons.unshift(noPrices);
    const rungs = rungsNearSpot(ladder.rungs, ladder.spot.midCents, MAX_RUNGS);
    const v = ok(
      reasons,
      reasons.some((r) => r.code === "CATEGORY_NOT_ALLOWED")
        ? { actor: "owner", hint: "Only the owner can allow the Crypto category, in the console." }
        : noPrices !== null
          ? { actor: "agent", hint: NO_PRICES_HINT }
          : {
              actor: "agent",
              hint: "Call plan_hedge with the asset, a floor or drop, and the most the owner wants to spend.",
            },
    );
    const view = {
      eventTicker: ladder.eventTicker,
      title: untrusted(ladder.title, "gemini"),
      asset: ladder.asset,
      kind: ladder.kind,
      expiry: ladder.expiry,
      spotCents: ladder.spot.midCents,
      settlementIndex: ladder.settlementIndex,
      rungCount: ladder.rungs.length,
      pricedRungCount: pricedRungCount(ladder),
      marketEnvironment: environment,
      rungs: rungs.map((r) => ({
        strikeCents: r.strikeCents,
        instrumentSymbol: r.instrumentSymbol,
        marketState: r.marketState,
        noBuyCents: r.noBuyCents,
        yesBidCents: r.yesBidCents,
        yesAskCents: r.yesAskCents,
      })),
      truncated: rungs.length < ladder.rungs.length,
      otherLadders: others
        .filter((l) => l.eventTicker !== ladder.eventTicker && l.openStrikeCount > 0)
        .slice(0, MAX_OTHER_LADDERS)
        .map((l) => ({ eventTicker: l.eventTicker, kind: l.kind, expiry: l.expiry })),
    };
    const strikes = ladder.rungs.map((r) => r.strikeCents);
    return {
      structured: { ...v, ladder: view },
      summary: `${ladder.asset} ${ladder.kind} ladder ${ladder.eventTicker} settles ${formatExpiry(ladder.expiry)}; spot ${formatPrice(ladder.spot.midCents)}; ${ladder.rungs.length} strikes from ${formatPrice(Math.min(...strikes))} to ${formatPrice(Math.max(...strikes))}${view.truncated ? `, the ${rungs.length} nearest spot listed` : ""}.${reasons.length > 0 ? ` ${reasons.map((r) => r.message).join(" ")}` : ""}`,
    };
  },
});
