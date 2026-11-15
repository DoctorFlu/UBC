import type { ToolContext } from "../context";
import { reason } from "../mcp/envelope";
import type { ResolvedMarket } from "../services";
import { describeFailure, notConfigured, type Failure } from "../support/failures";

/**
 * Looks a market up on Gemini. The mandate's category comes from Gemini's listing, never from
 * the agent, so a trade cannot pass the category rule by claiming the wrong category.
 */
export async function resolveTradeMarket(
  ctx: ToolContext,
  instrumentSymbol: string,
): Promise<{ market: ResolvedMarket; failure?: undefined } | { market?: undefined; failure: Failure }> {
  if (ctx.markets === undefined) return { failure: notConfigured.markets() };
  try {
    const market = await ctx.markets.resolveMarket(instrumentSymbol);
    if (market !== null) return { market };
  } catch (error) {
    return { failure: describeFailure(error, ctx) };
  }
  return {
    failure: {
      reason: reason("MARKET_NOT_FOUND", "Gemini has no market with that instrumentSymbol."),
      nextAction: {
        actor: "agent",
        hint: "Call list_markets or get_ladder and pass an instrumentSymbol exactly as returned.",
      },
    },
  };
}
