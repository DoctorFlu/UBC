/**
 * The mirror maker against a stub of both public books and the fake sandbox account: it copies
 * production's best bids and nothing else, never quotes what production does not show, never competes with
 * someone else's order and takes it only where production's price reaches it, never leaves a side empty
 * while it moves a quote, keeps to its caps and its pace, and leaves no order behind.
 */
import { describe, expect, it } from "vitest";
import { makerDoctor } from "../src/maker/doctor";
import { MirrorMaker, type MarketReader } from "../src/maker/maker";
import {
  mirrorQuotes,
  quoteChanges,
  quoteSteps,
  type MakerLimits,
  type MirrorInput,
  type MirrorRung,
} from "../src/maker/mirror";
import { makerSettings, MAKER_ORDER_PREFIX } from "../src/maker/settings";
import { createGeminiPrivateClient, type GeminiCredentials } from "../src/private";
import type { EventSummary, MarketContract, MarketEvent, OrderBook } from "../src/types";
import { FakeGeminiPrivate, unpacedLimiter } from "../testing/fake-private";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const EXPIRY = "2026-11-18T22:00:00.000Z";
const DAILY = "BTC2611182200";
const sym = (strike: number) => `GEMI-${DAILY}-HI${String(strike)}`;

const LIMITS: MakerLimits = {
  maxQuoteHundredths: 10_000,
  maxQuoteNotionalCents: 5_000,
  maxRestingNotionalCents: 100_000,
  maxRungInventoryHundredths: 50_000,
  maxInventoryNotionalCents: 200_000,
  closeBeforeMs: 120_000,
  staleAfterMs: 45_000,
};

const PRODUCTION: NonNullable<MirrorRung["production"]> = {
  marketState: "open",
  bid: { priceCents: 60, quantityHundredths: 2_500 },
  ask: { priceCents: 62, quantityHundredths: 4_000 },
  readAtMs: NOW,
};

function rung(overrides: Partial<MirrorRung> = {}): MirrorRung {
  return {
    symbol: sym(64_000),
    expiresAtMs: Date.parse(EXPIRY),
    production: PRODUCTION,
    sandbox: { marketState: "open", yesBidCents: null, yesAskCents: null },
    ...overrides,
  };
}

function input(overrides: Partial<MirrorInput> = {}): MirrorInput {
  return {
    rungs: [rung()],
    resting: [],
    recentPrices: new Map(),
    holdings: [],
    limits: LIMITS,
    nowMs: NOW,
    ...overrides,
  };
}

describe("mirrorQuotes", () => {
  it("bids YES at production's YES bid and NO at 100 minus production's YES ask, at production's sizes", () => {
    const plan = mirrorQuotes(input());
    expect(plan.skips).toEqual([]);
    expect(plan.quotes).toEqual([
      { symbol: sym(64_000), outcome: "yes", priceCents: 60, hundredths: 2_500 },
      { symbol: sym(64_000), outcome: "no", priceCents: 38, hundredths: 4_000 },
    ]);
  });

  it("caps each quote by contracts and by what it would cost", () => {
    const limits = { ...LIMITS, maxQuoteHundredths: 3_000, maxQuoteNotionalCents: 1_000 };
    const plan = mirrorQuotes(input({ limits }));
    // $10 at 60c is 16.66 contracts; $10 at 38c is 26.31, under the 30-contract cap.
    expect(plan.quotes.map((quote) => quote.hundredths)).toEqual([1_666, 2_631]);
  });

  it.each<[string, Partial<MirrorRung>, RegExp]>([
    ["production does not list it", { production: null }, /does not list/],
    [
      "production has it closed",
      { production: { ...PRODUCTION, marketState: "closed" } },
      /production has it closed/,
    ],
    ["production's book is stale", { production: { ...PRODUCTION, readAtMs: NOW - 46_000 } }, /stale/],
    ["production shows only one side", { production: { ...PRODUCTION, ask: null } }, /one side/],
    [
      "production's book is locked",
      { production: { ...PRODUCTION, ask: { priceCents: 60, quantityHundredths: 100 } } },
      /locked or crossed/,
    ],
    [
      "the sandbox has it post-only",
      { sandbox: { marketState: "post_only", yesBidCents: null, yesAskCents: null } },
      /post_only/,
    ],
    ["it expires within two minutes", { expiresAtMs: NOW + 119_000 }, /expires soon/],
    ["its expiry is unknown", { expiresAtMs: null }, /expiry is unknown/],
  ])("quotes nothing when %s", (_, overrides, reason) => {
    const plan = mirrorQuotes(input({ rungs: [rung(overrides)] }));
    expect(plan.quotes).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toMatch(reason);
  });

  it.each<[string, MirrorRung["sandbox"], "yes" | "no", RegExp]>([
    [
      "bids YES",
      { marketState: "open", yesBidCents: 55, yesAskCents: null },
      "yes",
      /YES bid that is not ours/,
    ],
    [
      "offers YES (bids NO)",
      { marketState: "open", yesBidCents: null, yesAskCents: 70 },
      "no",
      /YES offer that is not ours/,
    ],
  ])(
    "leaves the side to someone else who %s, and quotes the other side maker only",
    (_, sandbox, side, reason) => {
      const plan = mirrorQuotes(input({ rungs: [rung({ sandbox })] }));
      expect(plan.skips).toEqual([
        { symbol: sym(64_000), outcome: side, reason: expect.stringMatching(reason) as string },
      ]);
      const other = side === "yes" ? "no" : "yes";
      // Production's price there does not reach their order: nothing would fill.
      expect(plan.quotes).toEqual([
        {
          symbol: sym(64_000),
          outcome: other,
          priceCents: other === "yes" ? 60 : 38,
          hundredths: other === "yes" ? 2_500 : 4_000,
        },
      ]);
    },
  );

  it("may take someone else's order once production's own price reaches it, at its price", () => {
    // Someone bids NO at 41 (a YES offer at 59); production's YES bid is 60.
    const reached = mirrorQuotes(
      input({ rungs: [rung({ sandbox: { marketState: "open", yesBidCents: null, yesAskCents: 59 } })] }),
    );
    expect(reached.quotes).toEqual([
      { symbol: sym(64_000), outcome: "yes", priceCents: 60, hundredths: 2_500, mayTake: true },
    ]);
    // Someone bids YES at 63; production's NO bid is 38 (63 + 38 >= 100).
    const yesBid = mirrorQuotes(
      input({ rungs: [rung({ sandbox: { marketState: "open", yesBidCents: 63, yesAskCents: null } })] }),
    );
    expect(yesBid.quotes).toEqual([
      { symbol: sym(64_000), outcome: "no", priceCents: 38, hundredths: 4_000, mayTake: true },
    ]);
  });

  it("takes its own resting and just-replaced quotes in the sandbox book for its own", () => {
    const sandbox = { marketState: "open", yesBidCents: 59, yesAskCents: 63 };
    const plan = mirrorQuotes(
      input({
        rungs: [rung({ sandbox })],
        resting: [
          { orderId: "1", symbol: sym(64_000), outcome: "no", priceCents: 37, remainingHundredths: 100 },
        ],
        recentPrices: new Map([[`${sym(64_000)}|yes`, new Set([59])]]),
      }),
    );
    expect(plan.skips).toEqual([]);
    expect(plan.quotes).toHaveLength(2);
  });

  it("stops a side at its inventory cap, and everything at the total cap or when positions are unknown", () => {
    const rungCap = mirrorQuotes(
      input({ holdings: [{ symbol: sym(64_000), outcome: "yes", hundredths: 50_000, costCents: 30_000 }] }),
    );
    expect(rungCap.quotes.map((quote) => quote.outcome)).toEqual(["no"]);
    expect(rungCap.skips).toEqual([
      { symbol: sym(64_000), outcome: "yes", reason: expect.stringMatching(/holds as much/) as string },
    ]);
    const totalCap = mirrorQuotes(
      input({ holdings: [{ symbol: sym(63_000), outcome: "no", hundredths: 100, costCents: 200_000 }] }),
    );
    expect(totalCap.quotes).toEqual([]);
    expect(mirrorQuotes(input({ holdings: null })).quotes).toEqual([]);
  });

  it("fills rungs in order until the resting total reaches its cap", () => {
    const limits = { ...LIMITS, maxRestingNotionalCents: 2_000 };
    const plan = mirrorQuotes(input({ rungs: [rung(), rung({ symbol: sym(63_000) })], limits }));
    // 25 YES at 60c is $15; 40 NO at 38c ($15.20) would pass $20.
    expect(plan.quotes).toEqual([{ symbol: sym(64_000), outcome: "yes", priceCents: 60, hundredths: 2_500 }]);
    expect(plan.skips.every((skip) => /resting total/.test(skip.reason))).toBe(true);
  });

  it("never quotes a size that would cost less than a cent", () => {
    const tiny = rung({
      production: { ...PRODUCTION, bid: { priceCents: 1, quantityHundredths: 50 } },
    });
    expect(mirrorQuotes(input({ rungs: [tiny] })).quotes.map((quote) => quote.outcome)).toEqual(["no"]);
  });
});

describe("quoteChanges", () => {
  const want = [{ symbol: sym(64_000), outcome: "yes" as const, priceCents: 60, hundredths: 2_000 }];
  const order = (id: string, priceCents: number, remainingHundredths: number) => ({
    orderId: id,
    symbol: sym(64_000),
    outcome: "yes" as const,
    priceCents,
    remainingHundredths,
  });

  it("keeps an order at the quote's price with between half and all of its size left", () => {
    expect(quoteChanges([order("1", 60, 1_000)], want)).toEqual({
      cancel: [],
      replace: [],
      place: [],
      keep: [order("1", 60, 1_000)],
    });
  });

  it("replaces an order whose price moved, that is mostly filled, or that is larger than the quote", () => {
    for (const stale of [order("1", 59, 2_000), order("1", 60, 999), order("1", 60, 2_001)]) {
      expect(quoteChanges([stale], want)).toEqual({
        cancel: [],
        replace: [{ order: stale, quote: want[0] }],
        place: [],
        keep: [],
      });
    }
    expect(quoteChanges([], want)).toEqual({ cancel: [], replace: [], place: want, keep: [] });
  });

  it("keeps a fitting order wherever it is listed, and cancels a side's other orders and any side with no quote", () => {
    const changes = quoteChanges(
      [order("2", 59, 2_000), order("1", 60, 2_000), { ...order("3", 40, 100), outcome: "no" as const }],
      want,
    );
    expect(changes.keep.map((o) => o.orderId)).toEqual(["1"]);
    expect(changes.cancel.map((o) => o.orderId)).toEqual(["2", "3"]);
    expect(changes.replace).toEqual([]);
    expect(changes.place).toEqual([]);
    // With no fitting order, the first on the side is replaced and the rest cancelled.
    const doubled = quoteChanges([order("2", 59, 2_000), order("4", 58, 2_000)], want);
    expect(doubled.replace.map((r) => r.order.orderId)).toEqual(["2"]);
    expect(doubled.cancel.map((o) => o.orderId)).toEqual(["4"]);
  });
});

describe("quoteSteps", () => {
  const quote = (strike: number, outcome: "yes" | "no", priceCents: number) => ({
    symbol: sym(strike),
    outcome,
    priceCents,
    hundredths: 1_000,
  });
  const resting = (strike: number, outcome: "yes" | "no", priceCents: number) => ({
    orderId: `${String(strike)}${outcome}`,
    symbol: sym(strike),
    outcome,
    priceCents,
    remainingHundredths: 1_000,
  });
  const order = (steps: ReturnType<typeof quoteSteps>) =>
    steps.map(
      (step) => `${step.quote.symbol.slice(-7)} ${step.quote.outcome} ${String(step.quote.priceCents)}`,
    );

  it("places YES bids below spot first, nearest spot first, then above spot, then the NO bids", () => {
    const place = [
      quote(66_000, "yes", 20),
      quote(66_000, "no", 78),
      quote(62_000, "yes", 90),
      quote(62_000, "no", 8),
      quote(64_000, "yes", 55),
      quote(64_000, "no", 43),
      quote(65_000, "yes", 40),
      quote(65_000, "no", 58),
    ];
    expect(order(quoteSteps({ replace: [], place }))).toEqual([
      "HI64000 yes 55",
      "HI62000 yes 90",
      "HI65000 yes 40",
      "HI66000 yes 20",
      "HI64000 no 43",
      "HI62000 no 8",
      "HI65000 no 58",
      "HI66000 no 78",
    ]);
  });

  it("replaces a rung's NO bid first when the new YES bid would meet the NO bid it replaces", () => {
    // Production moved up 3c: a YES bid at 63 meets the old NO bid at 38 (63 + 38 >= 100).
    const steps = quoteSteps({
      replace: [
        { order: resting(64_000, "yes", 60), quote: quote(64_000, "yes", 63) },
        { order: resting(64_000, "no", 38), quote: quote(64_000, "no", 35) },
      ],
      place: [],
    });
    expect(order(steps)).toEqual(["HI64000 no 35", "HI64000 yes 63"]);
    expect(steps.map((step) => step.replaces?.orderId)).toEqual(["64000no", "64000yes"]);
    // Moved down: the new NO bid at 41 would meet the old YES bid at 60, and the YES bid goes first.
    const down = quoteSteps({
      replace: [
        { order: resting(64_000, "yes", 60), quote: quote(64_000, "yes", 57) },
        { order: resting(64_000, "no", 38), quote: quote(64_000, "no", 41) },
      ],
      place: [],
    });
    expect(order(down)).toEqual(["HI64000 yes 57", "HI64000 no 41"]);
  });
});

// ------------------------------------------------------------------------------- the maker, end to end

const MAKER_KEY = "account-MakerKeyNeverPrinted01";
const MAKER_SECRET = "MakerSecretNeverPrinted";
const EXECUTOR_KEY = "account-ExecutorKeyNeverPrint";

function contract(
  symbol: string,
  strike: number,
  state: string,
  yesBid: number | null,
  yesAsk: number | null,
): MarketContract {
  return {
    instrumentSymbol: symbol,
    ticker: `HI${String(strike)}`,
    label: `$${String(strike)} or above`,
    status: "active",
    marketState: state,
    expiry: EXPIRY,
    strike: { type: "above", value: String(strike), valueCents: strike * 100 },
    quote: {
      yesBuyCents: yesAsk,
      yesSellCents: yesBid,
      noBuyCents: yesBid === null ? null : 100 - yesBid,
      noSellCents: yesAsk === null ? null : 100 - yesAsk,
      yesBidCents: yesBid,
      yesAskCents: yesAsk,
      lastTradeCents: null,
    },
    resolutionSide: null,
    resolvedAt: null,
    settlementValue: null,
    quantityIncrement: "0.01",
    quantityMinimum: "0.01",
    priceIncrement: "0.01",
  };
}

function event(ticker: string, contracts: MarketContract[]): MarketEvent {
  return {
    id: ticker,
    ticker,
    title: ticker,
    category: "crypto",
    type: "binary",
    status: "active",
    expiry: EXPIRY,
    asset: "BTC",
    kind: "daily",
    isLadder: true,
    settlementIndex: "LS-LRRR-XBTUSD",
    volumeCents: null,
    contracts,
  };
}

function summary(e: MarketEvent, kind: EventSummary["kind"] = "daily"): EventSummary {
  return {
    id: e.id,
    ticker: e.ticker,
    title: e.title,
    category: e.category,
    type: e.type,
    status: e.status,
    expiry: e.expiry,
    asset: e.asset,
    kind,
    isLadder: true,
    contractCount: e.contracts.length,
    volumeCents: null,
  };
}

/** Production: a book per strike that a test moves. */
class Production implements MarketReader {
  readonly books = new Map<
    number,
    { bid: [number, number] | null; ask: [number, number] | null; state: string }
  >();
  listed = new Set<number>();
  failing = false;
  readonly calls: string[] = [];

  set(strike: number, bid: [number, number] | null, ask: [number, number] | null, state = "open"): void {
    this.books.set(strike, { bid, ask, state });
    this.listed.add(strike);
  }

  listEvents(): Promise<EventSummary[]> {
    return Promise.resolve([]);
  }

  getEvent(ticker: string): Promise<MarketEvent> {
    this.calls.push(`event ${ticker}`);
    if (this.failing) return Promise.reject(new Error("production unavailable"));
    const contracts = [...this.listed].map((strike) =>
      contract(sym(strike), strike, this.books.get(strike)?.state ?? "open", null, null),
    );
    return Promise.resolve(event(ticker, contracts));
  }

  getOrderBook(symbol: string): Promise<OrderBook> {
    this.calls.push(`book ${symbol}`);
    if (this.failing) return Promise.reject(new Error("production unavailable"));
    const strike = Number(symbol.split("-HI")[1]);
    const book = this.books.get(strike);
    const level = (side: [number, number] | null | undefined) =>
      side ? [{ priceCents: side[0], quantityHundredths: side[1] }] : [];
    return Promise.resolve({
      instrumentSymbol: symbol,
      bids: level(book?.bid),
      asks: level(book?.ask),
      fetchedAt: "",
    });
  }
}

/** The sandbox: its listing, and a public book that shows the fake account's open orders plus anyone else's. */
class Sandbox implements MarketReader {
  strikes = [64_000, 63_000];
  state = "open";
  readonly foreign = new Map<string, { yesBid?: number; yesAsk?: number }>();
  failing = false;

  constructor(private readonly account: FakeGeminiPrivate) {}

  listEvents(): Promise<EventSummary[]> {
    return Promise.resolve([
      summary(this.build()),
      { ...summary(this.build(), "hourly"), ticker: "BTC2611181300" },
    ]);
  }

  getEvent(): Promise<MarketEvent> {
    if (this.failing) return Promise.reject(new Error("sandbox unavailable"));
    return Promise.resolve(this.build());
  }

  getOrderBook(): Promise<OrderBook> {
    return Promise.reject(new Error("not used"));
  }

  private build(): MarketEvent {
    const open = [...this.account.orders.values()].filter((order) => order.status === "open");
    return event(
      DAILY,
      this.strikes.map((strike) => {
        const symbol = sym(strike);
        const mine = open.filter((order) => order.symbol === symbol);
        const yesBids = mine.filter((o) => o.outcome === "yes").map((o) => o.priceCents);
        const yesAsks = mine.filter((o) => o.outcome === "no").map((o) => 100 - o.priceCents);
        const other = this.foreign.get(symbol);
        if (other?.yesBid !== undefined) yesBids.push(other.yesBid);
        if (other?.yesAsk !== undefined) yesAsks.push(other.yesAsk);
        // Other accounts' orders the fake account's buys can meet.
        for (const order of this.account.foreign) {
          if (order.symbol !== symbol || order.hundredths <= 0) continue;
          if (order.outcome === "yes") yesBids.push(order.priceCents);
          else yesAsks.push(100 - order.priceCents);
        }
        return contract(
          symbol,
          strike,
          this.state,
          yesBids.length > 0 ? Math.max(...yesBids) : null,
          yesAsks.length > 0 ? Math.min(...yesAsks) : null,
        );
      }),
    );
  }
}

function setUp(limits: Partial<MakerLimits> = {}, maxPlacementsPerCycle = 8) {
  let now = NOW;
  const account = new FakeGeminiPrivate({ apiKey: MAKER_KEY, apiSecret: MAKER_SECRET, now: () => now });
  const production = new Production();
  production.set(64_000, [60, 2_500], [62, 4_000]);
  production.set(63_000, [81, 2_500], [85, 3_000]);
  const sandbox = new Sandbox(account);
  const lines: string[] = [];
  let id = 0;
  const maker = new MirrorMaker({
    production,
    sandbox,
    account: createGeminiPrivateClient({
      environment: "sandbox",
      credentials: { apiKey: MAKER_KEY, apiSecret: MAKER_SECRET },
      fetch: account.fetch,
      now: () => now,
      limiter: unpacedLimiter(),
    }),
    settings: {
      kinds: ["daily"],
      assets: ["BTC"],
      intervalMs: 15_000,
      limits: { ...LIMITS, ...limits },
      maxPlacementsPerCycle,
      discoveryMs: 60_000,
    },
    say: (line) => lines.push(line),
    now: () => now,
    newId: () => `test${String((id += 1))}`,
  });
  const resting = () =>
    [...account.orders.values()]
      .filter((order) => order.status === "open")
      .map(
        (order) =>
          `${order.symbol.slice(-7)} ${order.outcome} ${String(order.priceCents)} x${String(order.quantity)}`,
      )
      .sort();
  return {
    account,
    production,
    sandbox,
    maker,
    lines,
    resting,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MirrorMaker", () => {
  it("places maker-only buys with its prefix at production's prices, on the daily ladder only", async () => {
    const { account, maker, resting } = setUp();
    const report = await maker.cycle();
    expect(report).toMatchObject({ rungs: 2, quotes: 4, placed: 4, cancelled: 0, refused: 0 });
    expect(resting()).toEqual([
      "HI63000 no 15 x3000",
      "HI63000 yes 81 x2500",
      "HI64000 no 38 x4000",
      "HI64000 yes 60 x2500",
    ]);
    const placements = account.callsTo("/v1/prediction-markets/order").map((request) => request.fields);
    expect(placements.every((fields) => fields.makerOrCancel === true && fields.side === "buy")).toBe(true);
    expect(placements.every((fields) => String(fields.clientOrderId).startsWith(MAKER_ORDER_PREFIX))).toBe(
      true,
    );
    expect(placements.every((fields) => String(fields.symbol).includes(DAILY))).toBe(true);
  });

  it("changes nothing while production stands still, and replaces a side when production moves a tick", async () => {
    const { account, production, maker, resting, advance } = setUp();
    await maker.cycle();
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ kept: 4, placed: 0, cancelled: 0 });
    production.set(64_000, [61, 2_500], [62, 4_000]);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ kept: 3, placed: 1, cancelled: 1 });
    expect(resting()).toContain("HI64000 yes 61 x2500");
    expect(resting()).not.toContain("HI64000 yes 60 x2500");
    expect(account.callsTo("/v1/prediction-markets/order/cancel")).toHaveLength(1);
  });

  it("refills a quote the executor mostly took, at production's size", async () => {
    const { account, maker, resting, advance } = setUp();
    await maker.cycle();
    const yes = [...account.orders.values()].find((o) => o.symbol === sym(64_000) && o.outcome === "yes");
    if (!yes) throw new Error("no YES bid placed");
    account.fill(yes.orderId, 2_000);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ placed: 1, cancelled: 1 });
    expect(resting()).toContain("HI64000 yes 60 x2500");
  });

  it("withdraws a rung's quotes when production stops listing it, closes it, or goes stale", async () => {
    const { production, maker, resting, advance } = setUp();
    await maker.cycle();
    production.listed.delete(63_000);
    advance(15_000);
    await maker.cycle();
    expect(resting().filter((line) => line.startsWith("HI63000"))).toEqual([]);
    production.set(64_000, [60, 2_500], [62, 4_000], "closed");
    advance(15_000);
    await maker.cycle();
    expect(resting()).toEqual([]);

    const fresh = setUp();
    await fresh.maker.cycle();
    fresh.production.failing = true;
    fresh.advance(30_000);
    expect(await fresh.maker.cycle()).toMatchObject({ kept: 4, cancelled: 0 });
    fresh.advance(20_000);
    await fresh.maker.cycle();
    expect(fresh.resting()).toEqual([]);
    expect(fresh.lines.join("\n")).toMatch(/production's book is stale/);
  });

  it("leaves a ladder's quotes as they are while the sandbox cannot be read", async () => {
    const { sandbox, maker, resting, advance } = setUp();
    await maker.cycle();
    sandbox.failing = true;
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ cancelled: 0, placed: 0 });
    expect(resting()).toHaveLength(4);
  });

  it("leaves someone else's order untouched, and withdraws only its own quote on that side", async () => {
    const { account, production, maker, resting, advance } = setUp();
    await maker.cycle();
    // The executor's NO bid at 20c on $63,000 (a YES offer at 80), better than the maker's NO bid at 15c.
    account.foreign.push({ symbol: sym(63_000), outcome: "no", priceCents: 20, hundredths: 1_000 });
    production.set(63_000, [75, 2_500], [85, 3_000]);
    advance(15_000);
    await maker.cycle();
    expect(resting().filter((line) => line.startsWith("HI63000"))).toEqual(["HI63000 yes 75 x2500"]);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ placed: 0, cancelled: 0 });
    expect(account.foreign[0]?.hundredths).toBe(1_000);
    expect(account.selfCrosses).toEqual([]);
  });

  it("fills someone else's order once, at its price, when production's price reaches it; the caps stop more", async () => {
    const { account, production, maker, resting, lines, advance } = setUp({
      maxRungInventoryHundredths: 1_000,
    });
    account.foreign.push({ symbol: sym(63_000), outcome: "no", priceCents: 20, hundredths: 1_000 });
    production.set(63_000, [75, 2_500], [85, 3_000]);
    await maker.cycle();
    expect(account.foreign[0]?.hundredths).toBe(1_000);

    // Production's YES bid reaches 81: production would have filled their YES offer at 80 there.
    production.set(63_000, [81, 2_500], [85, 3_000]);
    advance(15_000);
    await maker.cycle();
    expect(account.foreign[0]?.hundredths).toBe(0);
    const taker = account
      .callsTo("/v1/prediction-markets/order")
      .filter((request) => request.fields.makerOrCancel !== true);
    expect(
      taker.map((request) => `${String(request.fields.outcome)} ${String(request.fields.price)}`),
    ).toEqual(["yes 0.81"]);
    const filled = [...account.orders.values()].filter((order) => order.filled > 0);
    expect(filled.map((order) => [order.filled, order.costUnits / order.filled])).toEqual([[1_000, 80]]);
    expect(lines.join("\n")).toMatch(/sent to meet an order that is not the maker's/);

    // The maker now holds its cap on that side: the rest of that bid goes, and another order there is
    // left alone however production moves.
    advance(15_000);
    await maker.cycle();
    expect(resting().filter((line) => line.startsWith("HI63000 yes"))).toEqual([]);
    account.foreign.push({ symbol: sym(63_000), outcome: "no", priceCents: 19, hundredths: 1_000 });
    production.set(63_000, [82, 2_500], [85, 3_000]);
    advance(15_000);
    await maker.cycle();
    expect(account.foreign[1]?.hundredths).toBe(1_000);
    expect([...account.orders.values()].filter((order) => order.filled > 0)).toHaveLength(1);
    expect(account.selfCrosses).toEqual([]);
  });

  it("never leaves a side empty: unchanged quotes stay, and a moved one is placed before its order goes", async () => {
    const { account, production, maker, advance } = setUp();
    await maker.cycle();
    const sides = [sym(64_000), sym(63_000)].flatMap((symbol) => [`${symbol}|yes`, `${symbol}|no`]);
    const empty: string[] = [];
    const requests: string[] = [];
    account.afterRequest = (route) => {
      requests.push(route.endsWith("cancel") ? "cancel" : "place");
      const open = [...account.orders.values()].filter((order) => order.status === "open");
      for (const side of sides) {
        if (!open.some((order) => `${order.symbol}|${order.outcome}` === side)) empty.push(side);
      }
    };

    // Production stands still: nothing is sent.
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ kept: 4, placed: 0, cancelled: 0 });
    expect(requests).toEqual([]);

    // A cent on one side, same size: exactly one placement, then one cancel.
    production.set(64_000, [61, 2_500], [62, 4_000]);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ kept: 3, placed: 1, replaced: 1, cancelled: 1 });
    expect(requests).toEqual(["place", "cancel"]);

    // Every quote moves, up (the new YES bid would meet the old NO bid) and down.
    production.set(64_000, [64, 2_500], [66, 4_000]);
    production.set(63_000, [78, 2_500], [82, 3_000]);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ kept: 0, placed: 4, replaced: 4, cancelled: 4 });
    expect(empty).toEqual([]);
    expect(account.selfCrosses).toEqual([]);
  });

  it("leaves an order stale for a cycle within a cent of production when out of placements, never further", async () => {
    const { production, maker, resting, advance } = setUp({}, 1);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await maker.cycle();
      advance(15_000);
    }
    expect(resting()).toHaveLength(4);
    // Both rungs' YES bids move a cent, the $63,000 NO bid moves two.
    production.set(64_000, [61, 2_500], [62, 4_000]);
    production.set(63_000, [82, 2_500], [87, 3_000]);
    expect(await maker.cycle()).toMatchObject({ placed: 1, replaced: 1, stale: 1, cancelled: 2 });
    // The first in line replaced; the other cent stale; the NO bid two cents off cancelled, not left.
    expect(resting()).toEqual(["HI63000 yes 81 x2500", "HI64000 no 38 x4000", "HI64000 yes 61 x2500"]);
  });

  it("skips a quote Gemini cancels as taking liquidity, and tries again only at a new price", async () => {
    const { account, production, maker, resting, lines, advance } = setUp();
    account.wouldTake = (order) => order.symbol === sym(64_000) && order.outcome === "yes";
    expect(await maker.cycle()).toMatchObject({ placed: 3, refused: 1 });
    expect(resting()).not.toContain("HI64000 yes 60 x2500");
    expect(lines.join("\n")).toMatch(/would have taken liquidity/);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ placed: 0, refused: 0 });
    account.wouldTake = () => false;
    production.set(64_000, [59, 2_500], [62, 4_000]);
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ placed: 1 });
    expect(resting()).toContain("HI64000 yes 59 x2500");
  });

  it("never sends a placement again blindly: one that got no answer is found in the account", async () => {
    const { account, maker, resting, advance } = setUp({}, 1);
    account.failNextPlacement({ kind: "drop-after" });
    expect(await maker.cycle()).toMatchObject({ placed: 0, refused: 0 });
    expect(resting()).toHaveLength(1);
    advance(15_000);
    await maker.cycle();
    advance(15_000);
    await maker.cycle();
    advance(15_000);
    await maker.cycle();
    advance(15_000);
    await maker.cycle();
    expect(resting()).toHaveLength(4);
    const placements = account
      .callsTo("/v1/prediction-markets/order")
      .map((r) => `${String(r.fields.symbol)} ${String(r.fields.outcome)}`);
    expect(new Set(placements).size).toBe(placements.length);
  });

  it("places at most its per-cycle number of quotes, and never holds back a cancel", async () => {
    const { production, maker, resting, advance } = setUp({}, 2);
    expect(await maker.cycle()).toMatchObject({ placed: 2 });
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ placed: 2 });
    production.listed.clear();
    advance(15_000);
    expect(await maker.cycle()).toMatchObject({ cancelled: 4, placed: 0 });
    expect(resting()).toEqual([]);
  });

  it("cancels its own orders when it starts and when it stops, and leaves other orders alone", async () => {
    const { account, maker, resting, lines } = setUp();
    await maker.cycle();
    // An order the account's owner placed by hand, with no maker prefix.
    account.orders.set("1", {
      orderId: "1",
      clientOrderId: "owner-1",
      symbol: sym(63_000),
      side: "buy",
      outcome: "yes",
      quantity: 100,
      filled: 0,
      priceCents: 10,
      costUnits: 0,
      status: "open",
      makerOnly: false,
      createdAt: EXPIRY,
      updatedAt: EXPIRY,
      cancelledAt: null,
    });
    const stop = new AbortController();
    const running = maker.run(stop.signal);
    stop.abort();
    await running;
    expect(resting()).toEqual(["HI63000 yes 10 x100"]);
    expect(lines.join("\n")).toMatch(
      /1 open order\(s\) on the maker's account are not the maker's: left alone/,
    );
    expect(lines.join("\n")).toMatch(/started: cancelled 4 order\(s\)/);
  });
});

describe("makerSettings", () => {
  const base = {
    GEMINI_MAKER_API_KEY: MAKER_KEY,
    GEMINI_MAKER_API_SECRET: MAKER_SECRET,
    GEMINI_API_KEY: EXECUTOR_KEY,
  };

  it("defaults to the daily BTC ladder", () => {
    const settings = makerSettings(base);
    expect(settings).toMatchObject({ kinds: ["daily"], assets: ["BTC"], intervalMs: 15_000 });
    expect(settings.limits).toMatchObject({ maxQuoteHundredths: 10_000, maxQuoteNotionalCents: 5_000 });
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ["production", { GEMINI_ENV: "production" }, /sandbox only/],
    ["a live-trading setting", { GEMINI_LIVE_TRADING: "on" }, /live trading/],
    ["the executor's key", { GEMINI_API_KEY: MAKER_KEY }, /the executor's key/],
    ["no maker secret", { GEMINI_MAKER_API_SECRET: "" }, /must both be set/],
    ["the hourly ladder", { MAKER_KINDS: "daily,hourly" }, /"hourly" is not one of them/],
    ["a one-second interval", { MAKER_INTERVAL_MS: "1000" }, /at least 5000/],
  ])("refuses %s, naming no key", (_, overrides, reason) => {
    let thrown: unknown;
    try {
      makerSettings({ ...base, ...overrides });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(reason);
    expect(String(thrown)).not.toContain(MAKER_KEY);
    expect(String(thrown)).not.toContain(MAKER_SECRET);
  });
});

describe("makerDoctor", () => {
  async function doctor(setUpAccount: (fake: FakeGeminiPrivate) => void = () => {}) {
    // The fixture ladder expires 18 Nov 22:00 UTC: the doctor reads the test's clock, never today's date.
    const now = () => NOW;
    const maker = new FakeGeminiPrivate({ apiKey: MAKER_KEY, apiSecret: MAKER_SECRET, now });
    const executor = new FakeGeminiPrivate({
      apiKey: EXECUTOR_KEY,
      apiSecret: "ExecutorSecretNeverPrinted",
      now,
    });
    setUpAccount(maker);
    const production = new Production();
    production.set(64_000, [60, 2_500], [62, 4_000]);
    const lines: string[] = [];
    const status = await makerDoctor({
      env: {
        GEMINI_MAKER_API_KEY: MAKER_KEY,
        GEMINI_MAKER_API_SECRET: MAKER_SECRET,
        GEMINI_API_KEY: EXECUTOR_KEY,
        GEMINI_API_SECRET: "ExecutorSecretNeverPrinted",
      },
      say: (line) => lines.push(line),
      production,
      sandbox: new Sandbox(maker),
      sandboxClient: (credentials: GeminiCredentials) =>
        createGeminiPrivateClient({
          environment: "sandbox",
          credentials,
          limiter: unpacedLimiter(),
          fetch: credentials.apiKey === MAKER_KEY ? maker.fetch : executor.fetch,
          now,
        }),
      now,
    });
    const output = lines.join("\n");
    for (const secret of [MAKER_KEY, MAKER_SECRET, EXECUTOR_KEY, "ExecutorSecretNeverPrinted"]) {
      expect(output).not.toContain(secret);
    }
    // Read-only.
    expect(maker.callsTo("/v1/prediction-markets/order")).toEqual([]);
    expect(maker.callsTo("/v1/prediction-markets/order/cancel")).toEqual([]);
    return { status, output };
  }

  it("is ready with both accounts able to trade, and shows each rung against production", async () => {
    const { status, output } = await doctor();
    expect(status).toBe(0);
    expect(output).toMatch(/maker: Prediction Markets terms accepted/);
    expect(output).toMatch(/executor: roles Trader/);
    expect(output).toMatch(
      /HI64000: production open 60\/62 \| sandbox open -\/- \| resting: none \| would quote: YES 60c x25, NO 38c x40/,
    );
    expect(output).toMatch(/HI63000: production not listed .*YES none \(production does not list it\)/);
    expect(output.trim().split("\n").at(-1)).toBe("READY");
  });

  it("is not ready when the maker's account has not accepted the terms", async () => {
    const { status, output } = await doctor((fake) => {
      fake.termsAccepted = false;
    });
    expect(status).toBe(1);
    expect(output).toMatch(/NOT READY: maker has not accepted the latest terms/);
  });
});
