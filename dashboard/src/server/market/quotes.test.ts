import { describe, expect, it } from "vitest";

import { RECORDED_EVENT, recordedResponse } from "../../../e2e/support/fake-gemini";
import { MarketQuotes, ladderQuotes } from "./quotes";

const NOW = Date.parse("2026-11-15T20:19:00Z");
/** Production lists it; the sandbox's copy of the ladder does not (it lists fewer strikes). */
const PRODUCTION_ONLY = `GEMI-${RECORDED_EVENT}-HI64000`;

/**
 * Two exchanges by host, as on a stack trading on the sandbox (18 November 2026): each its own spot, and
 * the sandbox without one strike of the recorded ladder.
 */
function exchanges(options: { productionEventsDown?: boolean } = {}) {
  const requests: string[] = [];
  const fetch = (input: string): Promise<Response> => {
    const url = new URL(input);
    const path = `${url.pathname}${url.search}`;
    const host = url.hostname.split(".")[0] ?? "";
    requests.push(`${host} ${path}`);
    if (path === "/v1/pubticker/btcusd") {
      const spot = host === "production" ? "64350.00" : "63650.00";
      return Promise.resolve(Response.json({ bid: spot, ask: spot, last: spot }));
    }
    if (host === "production" && options.productionEventsDown && path.startsWith("/v1/prediction-markets/")) {
      return Promise.resolve(Response.json({ error: "An unexpected error occurred" }, { status: 500 }));
    }
    let body = recordedResponse(path, NOW) as { contracts?: { instrumentSymbol: string }[] } | null;
    if (body === null) return Promise.resolve(new Response("{}", { status: 404 }));
    if (host === "sandbox" && body.contracts) {
      body = { ...body, contracts: body.contracts.filter((c) => c.instrumentSymbol !== PRODUCTION_ONLY) };
    }
    return Promise.resolve(Response.json(body));
  };
  const quotes = new MarketQuotes({
    baseUrl: "https://sandbox.gemini.test",
    productionBaseUrl: "https://production.gemini.test",
    fetch,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return { quotes, requests };
}

describe("the console's ladder quotes on a stack trading on the sandbox", () => {
  it("shows production's spot with the sandbox's books, and production's strikes the sandbox lacks", async () => {
    const { quotes, requests } = exchanges();
    const lookup = await quotes.ladder("BTC", RECORDED_EVENT);
    if (!lookup.ok) throw new Error(lookup.error.message);
    const shown = ladderQuotes(lookup.ladder, lookup.elsewhere);
    expect(shown.spotCents).toBe(6_435_000);
    expect(shown.spotBasis).toBe("mid");
    expect(shown.rungs.map((r) => r.instrumentSymbol)).not.toContain(PRODUCTION_ONLY);
    expect(shown.elsewhere).toEqual([{ instrumentSymbol: PRODUCTION_ONLY, strikeCents: 6_400_000 }]);
    expect(requests).toContain("production /v1/pubticker/btcusd");
    expect(requests).not.toContain("sandbox /v1/pubticker/btcusd");
  });

  it("keeps the ladder when production's listing cannot be read, and says so with elsewhere null", async () => {
    const { quotes } = exchanges({ productionEventsDown: true });
    const lookup = await quotes.ladder("BTC", RECORDED_EVENT);
    if (!lookup.ok) throw new Error(lookup.error.message);
    expect(lookup.elsewhere).toBeNull();
    expect(ladderQuotes(lookup.ladder, lookup.elsewhere).elsewhere).toBeNull();
  });

  it("asks production nothing more when the venue is production", async () => {
    const requests: string[] = [];
    const quotes = new MarketQuotes({
      baseUrl: "https://production.gemini.test",
      productionBaseUrl: "https://production.gemini.test",
      fetch: (input) => {
        const url = new URL(input);
        requests.push(`${url.pathname}${url.search}`);
        const body = recordedResponse(`${url.pathname}${url.search}`, NOW);
        return Promise.resolve(body === null ? new Response("{}", { status: 404 }) : Response.json(body));
      },
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const lookup = await quotes.ladder("BTC", RECORDED_EVENT);
    expect(lookup).toMatchObject({ ok: true, elsewhere: [] });
    expect(
      requests.filter((r) => r.startsWith(`/v1/prediction-markets/events/${RECORDED_EVENT}`)),
    ).toHaveLength(1);
  });
});
