/**
 * The Gemini venue against a fake of Gemini's private endpoints (`@mandate/gemini/testing`), which checks
 * every signature and nonce the way Gemini does, and the recorded public ladders. The rule under test
 * above all: one order per intent, whatever fails and whenever the executor restarts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { eventSchema, GeminiError, normalizeEvent, type MarketEvent } from "@mandate/gemini";
import { createGeminiPrivateClient } from "@mandate/gemini/private";
import { FakeGeminiPrivate, unpacedLimiter } from "@mandate/gemini/testing";
import type { VenueOrderRecord } from "@mandate/shared";
import {
  geminiVenue,
  memoryOrderJournal,
  type FillState,
  type HeldPosition,
  type Placement,
  type Venue,
  type VenueOrder,
} from "../src";

const FIXTURES = fileURLToPath(new URL("../../gemini/test/fixtures/", import.meta.url));
const KEY = "account-FAKEKEY000000000001";
const SECRET = "fake-secret-for-tests";
const POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEPLOY_BLOCK_HASH = `0xa1b2c3d4${"0".repeat(56)}` as const;

function recorded(file: string): MarketEvent {
  return normalizeEvent(eventSchema.parse(JSON.parse(readFileSync(`${FIXTURES}${file}`, "utf8"))));
}

/** Open until 2026-11-20 22:00 UTC. */
const OPEN = recorded("event-BTC2611202200.json");
/** Settled 2026-11-13: $68,500 and up resolved NO, $68,000 and below YES. */
const SETTLED = recorded("event-BTC2611132200-settled.json");
const MARKET = "GEMI-BTC2611202200-HI65000";
const SETTLED_NO = "GEMI-BTC2611132200-HI68500";
const ORDER_ROUTE = "/v1/prediction-markets/order";

let clock: { now: number };
let fake: FakeGeminiPrivate;
let journal: ReturnType<typeof memoryOrderJournal>;
let events: MarketEvent[];
let trading: ReturnType<typeof createGeminiPrivateClient>;

function venue(options: { orderTtlMs?: number } = {}): Venue {
  const now = () => clock.now;
  return geminiVenue({
    publicClient: {
      getEvent: (ticker) => {
        const event = events.find((candidate) => candidate.ticker === ticker);
        return event
          ? Promise.resolve(event)
          : Promise.reject(new GeminiError("not_found", `no event ${ticker}`, { status: 404 }));
      },
    },
    trading,
    journal,
    deployment: { chainId: 5_042_002, policy: POLICY, deployBlockHash: DEPLOY_BLOCK_HASH },
    now,
    ...options,
  });
}

function signedClient() {
  return createGeminiPrivateClient({
    environment: "sandbox",
    credentials: { apiKey: KEY, apiSecret: SECRET },
    fetch: fake.fetch,
    now: () => clock.now,
    limiter: unpacedLimiter(),
  });
}

/** The venue of a new executor process: a few seconds later, with a new signed client (nonce from 0). */
function restarted(): Venue {
  clock.now += 5_000;
  trading = signedClient();
  return venue();
}

const order = (patch: Partial<VenueOrder> = {}): VenueOrder => ({
  intentId: 7,
  market: MARKET,
  outcome: "NO",
  isBuy: true,
  amountCents: 1_300, // 40 contracts at 31c and the 60c worst-case fee
  limitPrice: 31,
  ...patch,
});

function placedOf(placement: Placement) {
  if (placement.status !== "placed") throw new Error(`expected placed, got ${JSON.stringify(placement)}`);
  return placement.placed;
}

const position = (patch: Partial<HeldPosition> = {}): HeldPosition => ({
  intentId: 7,
  market: SETTLED_NO,
  outcome: "NO",
  costCents: 1_240,
  limitPrice: 31,
  ...patch,
});

beforeEach(() => {
  clock = { now: Date.parse("2026-11-17T08:00:00Z") };
  fake = new FakeGeminiPrivate({ apiKey: KEY, apiSecret: SECRET, now: () => clock.now });
  journal = memoryOrderJournal();
  events = [OPEN, SETTLED];
  trading = signedClient();
});

describe("placing an order", () => {
  it("sends exactly the intent: market, side, outcome, limit price, and what the amount buys", async () => {
    const placed = placedOf(await venue().placeOrder(order()));
    const [sent] = fake.callsTo(ORDER_ROUTE);
    // $12.40 at 31c buys 40 contracts (4,000 hundredths); nothing more.
    expect(sent?.fields).toEqual({
      symbol: MARKET,
      orderType: "limit",
      side: "buy",
      quantity: "40",
      price: "0.31",
      outcome: "no",
      timeInForce: "good-til-cancel",
      clientOrderId: "mandate-5042002-5fbdb231-a1b2c3d4-7",
    });
    expect(placed.venueOrderId).toBe(fake.order(placed.venueOrderId).orderId);
    expect(journal.records.get(7)).toMatchObject({
      state: "open",
      environment: "sandbox",
      quantityHundredths: 4_000,
    });
  });

  it("writes the journal before sending, and sends nothing when the journal cannot be written", async () => {
    const seen: number[] = [];
    const put = journal.put.bind(journal);
    journal.put = (record: VenueOrderRecord) => {
      seen.push(fake.callsTo(ORDER_ROUTE).length);
      return put(record);
    };
    await venue().placeOrder(order());
    expect(journal.history[0]?.state).toBe("placing");
    expect(seen[0]).toBe(0);

    journal.failing = "the console did not answer";
    await expect(venue().placeOrder(order({ intentId: 8 }))).rejects.toThrow("the console did not answer");
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
  });

  it("places the order on the next try after a first journal write that failed, in the same process", async () => {
    // The live race: the executor sees the approval before the console does, which refuses the write
    // ("not_seen"). Nothing was sent, so the next try must send, not wait for an order that never was.
    const same = venue();
    const put = journal.put.bind(journal);
    let seen = false;
    journal.put = (record: VenueOrderRecord) =>
      seen ? put(record) : Promise.reject(new Error("the console did not store the order record: not_seen"));
    await expect(same.placeOrder(order())).rejects.toThrow("not_seen");
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(0);
    expect(journal.records.get(7)).toBeUndefined();

    seen = true;
    clock.now += 15_000;
    placedOf(await same.placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
    expect(journal.records.get(7)).toMatchObject({ state: "open", revision: 2 });
  });

  it("sends once, after a first write that landed although its answer was lost", async () => {
    const same = venue();
    const put = journal.put.bind(journal);
    let loseNextAnswer = true;
    journal.put = async (record: VenueOrderRecord) => {
      await put(record);
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new Error("the console at http://console.test did not answer (timeout)");
      }
    };
    await expect(same.placeOrder(order())).rejects.toThrow("did not answer");
    // The journal holds "placing", but this process knows that version never reached Gemini.
    expect(journal.records.get(7)?.state).toBe("placing");
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(0);

    placedOf(await same.placeOrder(order()));
    placedOf(await same.placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
    expect(journal.records.get(7)).toMatchObject({ state: "open", revision: 3 });
  });

  it("rounds down to the contract's quantity grid and refuses a price off its price grid", async () => {
    const coarse = structuredClone(OPEN);
    for (const contract of coarse.contracts) {
      contract.quantityIncrement = "1";
      contract.quantityMinimum = "1";
    }
    events = [coarse];
    // $12.40 at 33c buys 37.57 contracts: 37 whole ones on a grid of 1.
    placedOf(await venue().placeOrder(order({ limitPrice: 33 })));
    expect(fake.callsTo(ORDER_ROUTE)[0]?.fields.quantity).toBe("37");
    // 20 cents at 33c buys less than one contract, the minimum.
    expect(await venue().placeOrder(order({ intentId: 8, amountCents: 20, limitPrice: 33 }))).toMatchObject({
      status: "refused",
      detail: expect.stringMatching(/buys less than the 1 contracts/) as unknown,
    });

    for (const contract of coarse.contracts) contract.priceIncrement = "0.05";
    expect(await venue().placeOrder(order({ intentId: 9 }))).toMatchObject({
      status: "refused",
      detail: expect.stringMatching(/not on .* 5c price grid/) as unknown,
    });
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
  });

  it("sizes the order so its cost and Gemini's worst-case fee fit the approved amount, and refuses less than a cent", async () => {
    // 98c at 97c: 1 contract costs 97c and at most a 1c fee (the sandbox charged exactly that).
    placedOf(await venue().placeOrder(order({ amountCents: 98, limitPrice: 97 })));
    expect(fake.callsTo(ORDER_ROUTE)[0]?.fields.quantity).toBe("1");
    // $10 at 50c: 20 contracts would cost $10 and a 35c fee, so 19.32 is the most that fits.
    placedOf(await venue().placeOrder(order({ intentId: 8, amountCents: 1_000, limitPrice: 50 })));
    expect(fake.callsTo(ORDER_ROUTE)[1]?.fields.quantity).toBe("19.32");
    // 2c at 30c: 0.03 contracts fit (0.9c, rounded up to 1c, and a 1c fee), but they cost less than the
    // cent Gemini takes at least for an order, so Gemini would refuse it.
    expect(await venue().placeOrder(order({ intentId: 9, amountCents: 2, limitPrice: 30 }))).toEqual({
      status: "refused",
      detail: "0.03 contracts at 30c cost less than the $0.01 Gemini's sandbox takes for an order",
    });
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(2);
  });

  it("records an order Gemini refuses as refused, with Gemini's reason, and never sends it again", async () => {
    fake.failNextPlacement({
      kind: "refuse",
      status: 422,
      body: { error: "InsufficientFunds", message: "Insufficient funds" },
    });
    const first = await venue().placeOrder(order());
    expect(first).toEqual({
      status: "refused",
      detail:
        "Gemini's sandbox refused the order: InsufficientFunds (POST /v1/prediction-markets/order returned HTTP 422 (InsufficientFunds: Insufficient funds))",
    });
    expect(journal.records.get(7)?.state).toBe("rejected");
    expect(await venue().placeOrder(order())).toEqual(first);
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
  });

  it("holds the intent while the terms are not accepted, says so plainly, and places it once they are", async () => {
    fake.termsAccepted = false;
    const held = await venue().placeOrder(order());
    expect(held).toEqual({
      status: "held",
      detail:
        "the Gemini's sandbox account has not accepted the Prediction Markets terms; accept them on Gemini's site (never from code)",
    });
    expect(journal.records.get(7)?.state).toBe("not_placed");
    expect(fake.orders.size).toBe(0);

    fake.termsAccepted = true;
    placedOf(await venue().placeOrder(order()));
    expect(fake.orders.size).toBe(1);
    expect(journal.records.get(7)).toMatchObject({ state: "open", revision: 4 });
    // Never accepted from code: no request ever went to the accept route.
    expect(fake.requests.some((request) => request.path.endsWith("/terms/accept"))).toBe(false);
  });

  it("sends a retry under the id its record was journalled with, even one in the form before #117", async () => {
    fake.termsAccepted = false;
    await venue().placeOrder(order());
    const record = journal.records.get(7);
    if (!record) throw new Error("no record");
    journal.records.set(7, { ...record, clientOrderId: "mandate-5042002-5fbdb231-7" });

    fake.termsAccepted = true;
    placedOf(await venue().placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE).map((call) => call.fields.clientOrderId)).toEqual([
      "mandate-5042002-5fbdb231-a1b2c3d4-7",
      "mandate-5042002-5fbdb231-7",
    ]);
    expect(journal.records.get(7)?.clientOrderId).toBe("mandate-5042002-5fbdb231-7");
  });
});

describe("an attempt whose answer never came", () => {
  it("finds the order Gemini made by its client order id, and never sends it again", async () => {
    fake.failNextPlacement({ kind: "drop-after" });
    expect(await venue().placeOrder(order())).toMatchObject({
      status: "held",
      detail: expect.stringMatching(/no answer from Gemini's sandbox when placing it/) as unknown,
    });
    expect(journal.records.get(7)?.state).toBe("unknown");

    const placed = placedOf(await restarted().placeOrder(order()));
    expect(fake.orders.size).toBe(1);
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
    expect(placed.venueOrderId).toBe(String([...fake.orders.keys()][0]));
    expect(journal.records.get(7)?.state).toBe("open");
  });

  it("finds an order sent under an id journalled before #117 by that id, never by its terms alone", async () => {
    // A record journalled before #117 keeps its id in the old form; the attempt under it got no answer.
    const legacy = "mandate-5042002-5fbdb231-7";
    fake.termsAccepted = false;
    await venue().placeOrder(order());
    const record = journal.records.get(7);
    if (!record) throw new Error("no record");
    journal.records.set(7, { ...record, clientOrderId: legacy });
    fake.termsAccepted = true;
    fake.failNextPlacement({ kind: "drop-after" });
    expect(await venue().placeOrder(order())).toMatchObject({ status: "held" });
    // The owner's own order on the same terms, after the attempt: only the id tells the two apart.
    clock.now += 1_000;
    await trading.placeOrder({
      symbol: MARKET,
      side: "buy",
      outcome: "no",
      quantity: "40",
      price: "0.31",
      clientOrderId: "owner-1",
    });

    const placed = placedOf(await restarted().placeOrder(order()));
    const sent = [...fake.orders.values()].find((made) => made.clientOrderId === legacy);
    expect(placed.venueOrderId).toBe(sent?.orderId);
    expect(fake.callsTo(ORDER_ROUTE).filter((call) => call.fields.clientOrderId === legacy)).toHaveLength(1);
    expect(journal.records.get(7)).toMatchObject({ clientOrderId: legacy, state: "open" });
  });

  it("treats a redirect as an unknown outcome, never a refusal: held, looked up, never sent again", async () => {
    fake.failNextPlacement({ kind: "redirect", status: 302, location: "https://elsewhere.example/order" });
    expect(await venue().placeOrder(order())).toMatchObject({
      status: "held",
      detail: expect.stringMatching(
        /no answer from Gemini's sandbox when placing it \(.*redirect \(HTTP 302 to elsewhere\.example\); it was not followed/,
      ) as unknown,
    });
    expect(journal.records.get(7)).toMatchObject({ state: "unknown" });
    expect(journal.records.get(7)?.detail).toMatch(/\(redirected\); looking the order up/);

    expect(await restarted().placeOrder(order())).toMatchObject({ status: "held" });
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
    expect(journal.records.get(7)?.state).toBe("unknown");
  });

  it("matches by the order's exact terms when Gemini does not return client order ids", async () => {
    fake.echoClientOrderId = false;
    fake.failNextPlacement({ kind: "drop-after" });
    await venue().placeOrder(order());
    placedOf(await restarted().placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
  });

  it("holds the intent, and still sends nothing, when no order or several orders match", async () => {
    fake.failNextPlacement({ kind: "drop-before" });
    await venue().placeOrder(order());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await restarted().placeOrder(order())).toMatchObject({
        status: "held",
        detail: expect.stringMatching(
          /no order for 40 contracts at 31c on Gemini since the attempt; it is never sent again/,
        ) as unknown,
      });
    }
    expect(fake.orders.size).toBe(0);
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);

    // Two identical orders (the owner's own, say) and no client order ids: no guessing.
    fake.echoClientOrderId = false;
    for (let copy = 0; copy < 2; copy += 1) {
      clock.now += 1_000;
      await trading.placeOrder({ symbol: MARKET, side: "buy", outcome: "no", quantity: "40", price: "0.31" });
    }
    expect(await venue().placeOrder(order())).toMatchObject({
      status: "held",
      detail: expect.stringMatching(/2 orders for 40 contracts at 31c match; check Gemini/) as unknown,
    });
  });
});

describe("a request Gemini refused before reading it", () => {
  it("treats a refused nonce as not placed, never as unknown, and places the order next time", async () => {
    // A process started in the same second as the last one signs with a nonce Gemini already saw.
    await trading.roles();
    await trading.roles();
    trading = signedClient();
    expect(await venue().placeOrder(order())).toEqual({
      status: "held",
      detail:
        "Gemini's sandbox refused the request's nonce (InvalidNonce); is another process using this key?",
    });
    expect(journal.records.get(7)?.state).toBe("not_placed");
    expect(fake.orders.size).toBe(0);

    placedOf(await restarted().placeOrder(order()));
    expect(fake.orders.size).toBe(1);
  });
});

describe("following an order", () => {
  it("reports partial fills while open and the cost of the fill, rounded up, once filled", async () => {
    const gemini = venue();
    const placed = placedOf(await gemini.placeOrder(order()));
    expect(await gemini.readFill(placed)).toEqual({ state: "open", filledCents: 0 });
    expect(journal.records.get(7)).not.toHaveProperty("feeCents");

    fake.fill(placed.venueOrderId, 1_000, 30);
    expect(await gemini.readFill(placed)).toEqual({ state: "open", filledCents: 300 });
    // Gemini reports no fee, so the journal keeps the estimate: 0.07 x 10 x 0.30 x 0.70 = 14.7c, so 15c.
    expect(journal.records.get(7)).toMatchObject({ state: "open", filledHundredths: 1_000, feeCents: 15 });

    fake.fill(placed.venueOrderId);
    const done = await gemini.readFill(placed);
    // 10 at 30c and 30 at 31c: $3.00 + $9.30.
    expect(done).toEqual({ state: "closed", filledCents: 1_230, detail: "filled on Gemini's sandbox" });
    expect(journal.records.get(7)).toMatchObject({
      state: "filled",
      filledHundredths: 4_000,
      filledCents: 1_230,
      // At the average of 30.75c: 0.07 x 40 x 0.3075 x 0.6925 = 59.6c, so 60c.
      feeCents: 60,
    });
  });

  it("cancels what is left once the order's time is up, and records the part that filled", async () => {
    const gemini = venue({ orderTtlMs: 60_000 });
    const placed = placedOf(await gemini.placeOrder(order()));
    fake.fill(placed.venueOrderId, 1_550);
    clock.now += 30_000;
    expect((await gemini.readFill(placed)).state).toBe("open");
    expect(fake.callsTo("/v1/prediction-markets/order/cancel")).toHaveLength(0);

    clock.now += 31_000;
    expect((await gemini.readFill(placed)).state).toBe("open");
    expect(fake.callsTo("/v1/prediction-markets/order/cancel")).toHaveLength(1);
    const closed: FillState = await gemini.readFill(placed);
    expect(closed).toEqual({
      state: "closed",
      filledCents: 481,
      detail: "15.50 of 40 contracts filled on Gemini's sandbox, the rest cancelled",
    });
    expect(journal.records.get(7)?.state).toBe("partly_filled");
  });

  it("cancels a minute before the market stops trading, even before the order's time is up", async () => {
    clock.now = Date.parse("2026-11-20T21:58:00Z");
    const gemini = venue();
    const placed = placedOf(await gemini.placeOrder(order()));
    clock.now = Date.parse("2026-11-20T21:59:00Z");
    await gemini.readFill(placed);
    expect(fake.callsTo("/v1/prediction-markets/order/cancel")).toHaveLength(1);
    expect(await gemini.readFill(placed)).toMatchObject({ state: "closed", filledCents: 0 });
    expect(journal.records.get(7)?.state).toBe("cancelled");
  });
});

describe("settling a position", () => {
  async function filledOn(market: string, outcome: "YES" | "NO" = "NO") {
    const gemini = venue();
    const placed = placedOf(await gemini.placeOrder(order({ market, outcome })));
    fake.fill(placed.venueOrderId);
    await gemini.readFill(placed);
    return gemini;
  }

  it("asks nothing private while the public market trades", async () => {
    const gemini = venue();
    const before = fake.requests.length;
    expect(await gemini.positionOutcome(position({ market: MARKET }))).toMatchObject({ status: "open" });
    expect(fake.requests.length).toBe(before);
  });

  it("settles from the account's settled position when it agrees with the public outcome", async () => {
    const gemini = await filledOn(SETTLED_NO);
    // Published publicly, not settled on the account yet: wait.
    expect(await gemini.positionOutcome(position())).toEqual({
      status: "awaiting",
      expiresAt: "2026-11-13T22:00:00.000Z",
    });

    fake.settle(SETTLED_NO, "no", "BTC2611132200");
    expect(await gemini.positionOutcome(position())).toMatchObject({
      status: "resolved",
      resolution: "no",
      contractsHundredths: 4_000,
      payoutCents: 4_000,
      // The journal's estimate at the fill: 0.07 x 40 x 0.31 x 0.69 = 59.9c, so 60c.
      feeCents: 60,
    });
  });

  it("settles a journal record written before fees were estimated with the estimate its cost implies", async () => {
    const gemini = await filledOn(SETTLED_NO);
    const record = journal.records.get(7);
    if (!record) throw new Error("no journal record");
    const { feeCents: _, ...older } = record;
    journal.records.set(7, older);
    fake.settle(SETTLED_NO, "no", "BTC2611132200");
    expect(await gemini.positionOutcome(position())).toMatchObject({ status: "resolved", feeCents: 60 });
  });

  it("never settles when the account's settled position disagrees with the public outcome", async () => {
    const gemini = await filledOn(SETTLED_NO);
    fake.settle(SETTLED_NO, "yes", "BTC2611132200");
    const outcome = await gemini.positionOutcome(position());
    expect(outcome).toEqual({
      status: "disputed",
      detail:
        "settlement disagreement: the public event says NO won GEMI-BTC2611132200-HI68500, the account's settled position says YES; not settled until they agree",
    });
    // Reported where the owner sees the order.
    expect(journal.records.get(7)?.detail).toMatch(/settlement disagreement/);
  });

  it("never settles when Gemini settled fewer contracts than the order filled", async () => {
    const gemini = await filledOn(SETTLED_NO);
    fake.addSettledPosition({
      symbol: SETTLED_NO,
      outcome: "no",
      quantity: 1_000,
      resolutionSide: "no",
      eventTicker: "BTC2611132200",
    });
    expect(await gemini.positionOutcome(position())).toMatchObject({
      status: "disputed",
      detail: expect.stringMatching(/Gemini settled 10 contracts on .*, our order filled 40/) as unknown,
    });
  });

  it("settles a fill from before the executor traded on Gemini on the public outcome, as simulated", async () => {
    const outcome = await venue().positionOutcome(position());
    expect(outcome).toMatchObject({ status: "resolved", venue: "simulated", contractsHundredths: 4_000 });
    expect(outcome).not.toHaveProperty("feeCents");
    expect(fake.requests).toHaveLength(0);
  });
});
