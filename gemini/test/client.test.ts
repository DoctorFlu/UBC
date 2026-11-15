import { describe, expect, it } from "vitest";
import { GeminiError, isGeminiError, type FetchLike } from "../src/index";
import { fakeClock, fixture, json, recordedApi, routedFetch, testClient } from "./helpers";

async function caught(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GeminiError) return error;
    throw error;
  }
  throw new Error("expected a GeminiError");
}

describe("listEvents", () => {
  it("filters crypto server-side and returns summaries without contracts", async () => {
    const api = recordedApi();
    const events = await testClient(api.fetch).listEvents({ asset: "btc", kind: "weekly" });
    expect(api.calls).toEqual([
      "/v1/prediction-markets/events?status=active&category=Crypto&limit=500&offset=0",
    ]);
    expect(events).toEqual([
      {
        id: expect.any(String) as string,
        ticker: "BTC2611202200",
        title: "BTC price on November 20",
        category: "Crypto",
        type: "categorical",
        status: "active",
        expiry: "2026-11-20T22:00:00.000Z",
        asset: "BTC",
        kind: "weekly",
        isLadder: true,
        contractCount: 21,
        volumeCents: expect.any(Number) as number,
      },
    ]);
  });

  it("follows pagination and drops events that moved between pages", async () => {
    const page = fixture("events-crypto.json") as { data: { ticker: string }[] };
    const first = page.data.slice(0, 4);
    const second = page.data.slice(3);
    const total = first.length + second.length;
    const api = routedFetch([
      [
        "/v1/prediction-markets/events?",
        (path) => {
          const offset = Number(new URL(`https://x${path}`).searchParams.get("offset"));
          // Pretend the page size is 4 by returning a full page of 500 only for offset 0.
          const data = offset === 0 ? [...first, ...Array.from({ length: 496 }, () => first[0])] : second;
          return json({ data, pagination: { limit: 500, offset, total: total + 496 } });
        },
      ],
    ]);
    const events = await testClient(api.fetch).listEvents({ category: "Crypto" });
    expect(api.calls).toHaveLength(2);
    expect(events.map((e) => e.ticker)).toEqual(page.data.map((e) => e.ticker));
  });

  it("serves repeated calls from the cache until the TTL passes", async () => {
    const api = recordedApi();
    const clock = fakeClock();
    const client = testClient(api.fetch, clock);
    await client.listEvents({ asset: "BTC" });
    await client.listEvents({ asset: "BTC", kind: "daily" });
    expect(api.calls).toHaveLength(1);
    clock.now += 15_001;
    await client.listEvents({ asset: "BTC" });
    expect(api.calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const api = recordedApi();
    const client = testClient(api.fetch);
    await Promise.all([
      client.listLadders("BTC"),
      client.listLadders("ETH"),
      client.listEvents({ asset: "BTC" }),
    ]);
    expect(api.calls).toHaveLength(1);
  });
});

describe("listLadders", () => {
  it("lists every open BTC ladder with its kind, soonest first", async () => {
    const ladders = await testClient(recordedApi().fetch).listLadders("BTC");
    expect(ladders.map((l) => [l.eventTicker, l.kind, l.strikeCount])).toEqual([
      ["BTC2611152100", "hourly", 10],
      ["BTC2611152200", "daily", 21],
      ["BTC2611202200", "weekly", 21],
      ["BTC2611302200", "month-end", 12],
    ]);
    expect(ladders[2]).toMatchObject({ lowestStrikeCents: 6_100_000, highestStrikeCents: 7_100_000 });
  });

  it("drops ladders that have already expired", async () => {
    const clock = fakeClock(Date.parse("2026-11-15T21:30:00Z"));
    const ladders = await testClient(recordedApi().fetch, clock).listLadders("BTC");
    expect(ladders.map((l) => l.kind)).toEqual(["daily", "weekly", "month-end"]);
  });
});

describe("getLadder", () => {
  it("returns a sorted, typed weekly ladder with spot", async () => {
    const api = recordedApi();
    const ladder = await testClient(api.fetch).getLadder({ asset: "BTC", horizon: "weekly" });
    expect(ladder).toMatchObject({
      asset: "BTC",
      eventTicker: "BTC2611202200",
      kind: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      spot: { midCents: 6_471_001 },
    });
    expect(ladder.rungs).toHaveLength(21);
    const strikes = ladder.rungs.map((r) => r.strikeCents);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    for (const rung of ladder.rungs) {
      expect(Number.isInteger(rung.noBuyCents)).toBe(true);
      expect(rung.depth).toBeUndefined();
    }
    expect(api.calls.filter((c) => c.startsWith("/v1/book/"))).toEqual([]);
  });

  it("picks a ladder by exact expiry", async () => {
    const ladder = await testClient(recordedApi().fetch).getLadder({
      asset: "BTC",
      expiry: new Date("2026-11-30T22:00:00Z"),
    });
    expect(ladder.kind).toBe("month-end");
  });

  it("fetches top-of-book depth for the protective strikes only", async () => {
    const api = recordedApi();
    const ladder = await testClient(api.fetch).getLadder({
      asset: "BTC",
      horizon: "weekly",
      depth: "below-spot",
    });
    const books = api.calls.filter((c) => c.startsWith("/v1/book/"));
    // Spot is $64,710.01, so strikes $61,000 to $65,000 (the first strike above spot) qualify.
    expect(books).toHaveLength(9);
    expect(books.at(-1)).toBe("/v1/book/GEMI-BTC2611202200-HI65000");
    const withDepth = ladder.rungs.filter((r) => r.depth !== undefined);
    expect(withDepth.map((r) => r.strikeCents).at(-1)).toBe(6_500_000);
    // Every book request answers with the recorded $61,000 book: 25 contracts bid, 4,545 offered.
    expect(withDepth[0]?.depth).toEqual({ noBuyHundredths: 2_500, yesBuyHundredths: 454_500 });
  });

  it("explains which ladders exist when none matches", async () => {
    const error = await caught(
      testClient(recordedApi().fetch).getLadder({ asset: "BTC", expiry: "2026-11-21T22:00:00Z" }),
    );
    expect(error.code).toBe("no_ladder");
    expect(error.message).toContain("weekly 2026-11-20T22:00:00.000Z (BTC2611202200)");
  });

  it("requires a way to choose the ladder", async () => {
    const error = await caught(testClient(recordedApi().fetch).getLadder({ asset: "BTC" }));
    expect(error.code).toBe("invalid_argument");
  });

  it("rejects path injection in identifiers", async () => {
    const client = testClient(recordedApi().fetch);
    expect((await caught(client.getEvent("../v1/order"))).code).toBe("invalid_argument");
    expect((await caught(client.getOrderBook("A/B"))).code).toBe("invalid_argument");
  });
});

describe("other endpoints", () => {
  it("lists recently settled events for an asset", async () => {
    const settled = await testClient(recordedApi().fetch).listRecentlySettled({ asset: "BTC", limit: 3 });
    for (const event of settled) {
      expect(event.asset).toBe("BTC");
      expect(event.settlementValue).not.toBeNull();
    }
  });

  it("lists categories", async () => {
    const api = routedFetch([
      ["/v1/prediction-markets/categories", () => json({ categories: ["Crypto", "Sports"] })],
    ]);
    expect(await testClient(api.fetch).listCategories()).toEqual(["Crypto", "Sports"]);
  });
});

describe("retries, timeouts and errors", () => {
  function flaky(responses: (() => Response)[]): { fetch: FetchLike; count: () => number } {
    let calls = 0;
    return {
      fetch: () => {
        const next = responses[Math.min(calls, responses.length - 1)];
        calls++;
        if (next === undefined) throw new Error("no response");
        return Promise.resolve(next());
      },
      count: () => calls,
    };
  }

  it("retries 5xx with exponential backoff and jitter, then succeeds", async () => {
    const api = flaky([
      () => json({ error: "busy" }, 503),
      () => json({ error: "busy" }, 502),
      () => json(fixture("pubticker-btcusd.json")),
    ]);
    const clock = fakeClock();
    const spot = await testClient(api.fetch, clock).getSpot("BTC");
    expect(spot.midCents).toBe(6_471_001);
    expect(api.count()).toBe(3);
    // random() is 0.5, base delay 500 ms: 0.5 * 500, then 0.5 * 1000.
    expect(clock.sleeps).toEqual([250, 500]);
  });

  it("honours Retry-After on 429", async () => {
    const api = flaky([
      () => json({ error: "slow down" }, 429, { "retry-after": "2" }),
      () => json(fixture("pubticker-btcusd.json")),
    ]);
    const clock = fakeClock();
    await testClient(api.fetch, clock).getSpot("BTC");
    expect(clock.sleeps).toEqual([2000]);
  });

  it("gives up after the retry budget with a typed error", async () => {
    const api = flaky([() => json({ error: "down" }, 500)]);
    const error = await caught(testClient(api.fetch).getSpot("BTC"));
    expect(error).toMatchObject({ code: "http", status: 500, attempts: 4, path: "/v1/pubticker/btcusd" });
    expect(api.count()).toBe(4);
    const limited = flaky([() => json({ error: "slow" }, 429)]);
    expect((await caught(testClient(limited.fetch).getSpot("BTC"))).code).toBe("rate_limited");
  });

  it("does not retry 404 or other 4xx", async () => {
    const missing = flaky([() => json({ error: "Event not found" }, 404)]);
    const error = await caught(testClient(missing.fetch).getEvent("NOPE123"));
    expect(isGeminiError(error, "not_found")).toBe(true);
    expect(missing.count()).toBe(1);
    const bad = flaky([() => json({ error: "bad" }, 400)]);
    expect((await caught(testClient(bad.fetch).getEvent("X"))).code).toBe("http");
    expect(bad.count()).toBe(1);
  });

  it("rejects bodies that are not JSON or have the wrong shape, without retrying", async () => {
    const html = flaky([() => new Response("<html>", { status: 200 })]);
    expect((await caught(testClient(html.fetch).getSpot("BTC"))).code).toBe("invalid_response");
    expect(html.count()).toBe(1);
    const shape = flaky([() => json({ bids: "nope", asks: [] })]);
    const error = await caught(testClient(shape.fetch).getOrderBook("GEMI-X"));
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("bids");
  });

  it("times out a hanging request and retries it", async () => {
    let calls = 0;
    const hanging: FetchLike = (_input, init) => {
      calls++;
      if (calls === 2) return Promise.resolve(json(fixture("pubticker-btcusd.json")));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const spot = await testClient(hanging, fakeClock(), { timeoutMs: 20 }).getSpot("BTC");
    expect(spot.midCents).toBe(6_471_001);
    const never: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const error = await caught(
      testClient(never, fakeClock(), { timeoutMs: 10, maxRetries: 1 }).getSpot("BTC"),
    );
    expect(error).toMatchObject({ code: "timeout", attempts: 2 });
  });

  it("reports network failures as network errors", async () => {
    const offline: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const error = await caught(testClient(offline, fakeClock(), { maxRetries: 0 }).getSpot("BTC"));
    expect(error).toMatchObject({ code: "network", attempts: 1 });
  });
});
