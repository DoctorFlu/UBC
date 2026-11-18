import { createGeminiClient, GEMINI_HOSTS, type Ladder } from "@mandate/gemini";
import {
  DAILY,
  TWO_EXCHANGES_AT,
  type TwoExchangeOptions,
  twoExchangeFetch,
} from "@mandate/gemini/two-exchanges";

/**
 * A ladder read from the two-exchange fixture through Gemini's own client, with the books `plan_hedge`
 * reads (`depth: "below-spot"`), so the planner sees exactly what the agent passes it.
 */
export async function fixtureLadder(
  environment: "production" | "sandbox",
  options: TwoExchangeOptions & { eventTicker?: string } = {},
): Promise<Ladder> {
  // The client's own clock moves only by what it sleeps, so its rate limiter refills.
  let at = TWO_EXCHANGES_AT;
  const { eventTicker = DAILY, ...exchanges } = options;
  const { fetch } = twoExchangeFetch(() => at, exchanges);
  const client = createGeminiClient({
    baseUrl: GEMINI_HOSTS[environment],
    fetch,
    now: () => at,
    maxRetries: 0,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
  });
  return client.getLadder({ asset: "BTC", eventTicker, depth: "below-spot" });
}
