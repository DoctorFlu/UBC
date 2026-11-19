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
const CANCEL_ROUTE = "/v1/prediction-markets/order/cancel";

let clock: { now: number };
let fake: FakeGeminiPrivate;
let journal: ReturnType<typeof memoryOrderJournal>;
let events: MarketEvent[];
/** What Gemini's production exchange lists, where simulated fills are resolved. Default: `events`. */
let productionEvents: MarketEvent[] | undefined;
/** The event tickers each exchange was asked for. */
let asked: { venue: string[]; production: string[] };

function lookup(list: MarketEvent[], ticker: string): Promise<MarketEvent> {
  const event = list.find((candidate) => candidate.ticker === ticker);
  return event
    ? Promise.resolve(event)
    : Promise.reject(new GeminiError("not_found", `no event ${ticker}`, { status: 404 }));
}
let trading: ReturnType<typeof createGeminiPrivateClient>;

function venue(options: { orderTtlMs?: number; matchByTerms?: boolean } = {}): Venue {
  const now = () => clock.now;
  return geminiVenue({
    publicClient: {
      getEvent: (ticker) => {
        asked.venue.push(ticker);
        return lookup(events, ticker);
      },
    },
    productionClient: {
      getEvent: (ticker) => {
        asked.production.push(ticker);
        return lookup(productionEvents ?? events, ticker);
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
function restarted(options: { matchByTerms?: boolean } = {}): Venue {
  clock.now += 5_000;
  trading = signedClient();
  return venue(options);
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
  productionEvents = undefined;
  asked = { venue: [], production: [] };
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
      clientOrderId: "m-3820591c52173a5992cf-7",
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
      "m-3820591c52173a5992cf-7",
      "mandate-5042002-5fbdb231-7",
    ]);
    expect(journal.records.get(7)?.clientOrderId).toBe("mandate-5042002-5fbdb231-7");
  });

  it("sends a retry under an id journalled in main's form from #120 too", async () => {
    const journalled = "mandate-5042002-5fbdb231-a1b2c3d4-7";
    fake.termsAccepted = false;
    await venue().placeOrder(order());
    const record = journal.records.get(7);
    if (!record) throw new Error("no record");
    journal.records.set(7, { ...record, clientOrderId: journalled });

    fake.termsAccepted = true;
    placedOf(await venue().placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE).at(-1)?.fields.clientOrderId).toBe(journalled);
    expect(journal.records.get(7)?.clientOrderId).toBe(journalled);
  });

  it("sends an id of Gemini's full 36 characters at the largest intent id it carries", async () => {
    const intentId = 9_999_999_999_999;
    placedOf(await venue().placeOrder(order({ intentId })));
    const sent = fake.callsTo(ORDER_ROUTE).at(-1)?.fields.clientOrderId;
    expect(sent).toBe("m-3820591c52173a5992cf-9999999999999");
    expect(String(sent)).toHaveLength(36);
  });

  it("refuses an intent whose id does not fit Gemini's 36 characters, before journalling or sending it", async () => {
    const intentId = 10_000_000_000_000;
    expect(await venue().placeOrder(order({ intentId }))).toEqual({
      status: "refused",
      detail:
        "intent 10000000000000 does not fit Gemini's 36-character client order id (the largest intent id it can carry is 9999999999999)",
    });
    expect(journal.records.has(intentId)).toBe(false);
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(0);
  });

  it("is refused by Gemini, as the sandbox does, when a journalled id is longer than 36 characters", async () => {
    // The form #118 first used: 38 characters before the intent id. Gemini made no order.
    const tooLong = "mandate-5042002-5fbdb231-3820591c5217-7";
    fake.termsAccepted = false;
    await venue().placeOrder(order());
    const record = journal.records.get(7);
    if (!record) throw new Error("no record");
    journal.records.set(7, { ...record, clientOrderId: tooLong });

    fake.termsAccepted = true;
    expect(await venue().placeOrder(order())).toEqual({
      status: "refused",
      detail:
        "Gemini's sandbox refused the order: InvalidInput (POST /v1/prediction-markets/order returned HTTP 400 (InvalidInput: client_order_id must be at most 36 characters))",
    });
    expect(journal.records.get(7)?.state).toBe("rejected");
    expect(fake.orders.size).toBe(0);
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

  it("never matches by terms when the account serves several mandates: holds, sends nothing (#95)", async () => {
    fake.echoClientOrderId = false;
    fake.failNextPlacement({ kind: "drop-before" });
    await venue({ matchByTerms: false }).placeOrder(order());
    // Another mandate's order on the same account, with the same terms, placed after the attempt.
    clock.now += 1_000;
    await trading.placeOrder({ symbol: MARKET, side: "buy", outcome: "no", quantity: "40", price: "0.31" });
    expect(await restarted({ matchByTerms: false }).placeOrder(order())).toMatchObject({
      status: "held",
      detail: expect.stringMatching(/places orders for several mandates/) as unknown,
    });
    // The dropped attempt and the other mandate's order; nothing sent again, nothing adopted.
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(2);
    expect(fake.orders.size).toBe(1);
    expect(journal.records.get(7)?.venueOrderId ?? null).toBeNull();
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

  it("ends a 'placing' attempt Gemini never received as refused once the market is gone, never sending it", async () => {
    // The process stopped after journalling "placing", before it knew whether the order went out.
    fake.failNextPlacement({ kind: "drop-before" });
    await venue().placeOrder(order());
    const record = journal.records.get(7);
    if (!record) throw new Error("no journal record");
    journal.records.set(7, { ...record, state: "placing", detail: null });

    // While the market trades, it waits: an order of this attempt could still be on its way.
    expect(await restarted().placeOrder(order())).toMatchObject({ status: "held" });
    // The ladder leaves the listing: no such order on Gemini, and none can arrive and fill now.
    events = [];
    const detail =
      "an earlier attempt got no answer, no order for 40 contracts at 31c on Gemini since the attempt, and " +
      `Gemini's sandbox does not list ${MARKET}: nothing filled`;
    expect(await restarted().placeOrder(order())).toEqual({ status: "refused", detail });
    expect(journal.records.get(7)).toMatchObject({ state: "rejected", detail });
    expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
    expect(fake.orders.size).toBe(0);
  });

  it("keeps holding a lost attempt on a gone market while Gemini's answer proves nothing", async () => {
    fake.echoClientOrderId = false;
    fake.failNextPlacement({ kind: "drop-before" });
    await venue({ matchByTerms: false }).placeOrder(order());
    // Another mandate's order on the same account: it might be this one.
    clock.now += 1_000;
    await trading.placeOrder({ symbol: MARKET, side: "buy", outcome: "no", quantity: "40", price: "0.31" });
    events = [];
    expect(await restarted({ matchByTerms: false }).placeOrder(order())).toMatchObject({
      status: "held",
      detail: expect.stringMatching(/places orders for several mandates/) as unknown,
    });
    expect(journal.records.get(7)?.state).toBe("unknown");
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

  it("sends a new attempt with the client order id the journal already holds, from before #95's form", async () => {
    await trading.roles();
    await trading.roles();
    trading = signedClient();
    await venue().placeOrder(order());
    const journaled = journal.records.get(7);
    if (!journaled) throw new Error("nothing journaled");
    // As an executor from before the hashed form would have written it.
    journal.records.set(7, { ...journaled, clientOrderId: "mandate-5042002-5fbdb231-7" });
    placedOf(await restarted().placeOrder(order()));
    expect(fake.callsTo(ORDER_ROUTE).at(-1)?.fields.clientOrderId).toBe("mandate-5042002-5fbdb231-7");
    expect(journal.records.get(7)?.clientOrderId).toBe("mandate-5042002-5fbdb231-7");
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
    expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(0);

    clock.now += 31_000;
    // The cancel, then a read of what Gemini holds after it, in the same poll.
    const closed: FillState = await gemini.readFill(placed);
    expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(1);
    expect(closed).toEqual({
      state: "closed",
      filledCents: 481,
      detail: "15.50 of 40 contracts filled on Gemini's sandbox, the rest cancelled",
    });
    expect(journal.records.get(7)?.state).toBe("partly_filled");
  });

  it("asks again on the next poll when Gemini refuses the cancel for a reason that is not the order's", async () => {
    const gemini = venue({ orderTtlMs: 60_000 });
    const placed = placedOf(await gemini.placeOrder(order()));
    fake.fill(placed.venueOrderId, 1_550);
    clock.now += 61_000;
    fake.refuseNextCancel({ status: 429, body: { result: "error", reason: "RateLimit" } });

    // The cancel is refused and the order still works: nothing is recorded closed.
    expect(await gemini.readFill(placed)).toEqual({ state: "open", filledCents: 481 });
    expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(1);
    expect(fake.order(placed.venueOrderId).status).toBe("open");
    expect(journal.records.get(7)?.state).toBe("open");

    // The next poll asks again, Gemini cancels, and the part that filled is recorded.
    expect(await gemini.readFill(placed)).toEqual({
      state: "closed",
      filledCents: 481,
      detail: "15.50 of 40 contracts filled on Gemini's sandbox, the rest cancelled",
    });
    expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(2);
    expect(fake.order(placed.venueOrderId).status).toBe("cancelled");
    expect(journal.records.get(7)?.state).toBe("partly_filled");
  });

  describe("an order Gemini reports partly filled in a status of its own while it still works (#12)", () => {
    // On 18 Nov 2026 the sandbox reported intent #12's order, 5 of 11.81 filled and still working, in a
    // status other than "open". The venue took it for closed and recorded "the rest cancelled"; the rest
    // filled 34 seconds later.
    beforeEach(() => {
      fake.partialStatus = "partially_filled";
    });

    const cancelWording = () => journal.history.filter((record) => /cancel/i.test(record.detail ?? ""));

    it("keeps following it until Gemini says it filled, and records one result: all of it filled", async () => {
      const gemini = venue();
      const placed = placedOf(await gemini.placeOrder(order()));
      fake.fill(placed.venueOrderId, 500);
      expect(fake.order(placed.venueOrderId).status).toBe("open");

      expect(await gemini.readFill(placed)).toEqual({ state: "open", filledCents: 155 });
      expect(journal.records.get(7)).toMatchObject({
        state: "open",
        filledHundredths: 500,
        detail: "5 of 40 contracts filled so far",
      });

      fake.fill(placed.venueOrderId);
      expect(await gemini.readFill(placed)).toEqual({
        state: "closed",
        filledCents: 1_240,
        detail: "filled on Gemini's sandbox",
      });
      expect(journal.records.get(7)).toMatchObject({ state: "filled", filledHundredths: 4_000 });
      expect(journal.history.map((record) => record.state)).not.toContain("partly_filled");
      expect(cancelWording()).toEqual([]);
      expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(0);
    });

    it("records it open when the placement's own answer is partly filled", async () => {
      // Another account's YES bid at 69c meets 5 contracts of the NO bid at 31c as it is placed.
      fake.foreign.push({ symbol: MARKET, outcome: "yes", priceCents: 69, hundredths: 500 });
      const gemini = venue();
      const placed = placedOf(await gemini.placeOrder(order()));
      expect(journal.records.get(7)).toMatchObject({ state: "open", filledHundredths: 500 });
      expect(await gemini.readFill(placed)).toEqual({ state: "open", filledCents: 155 });
      expect(cancelWording()).toEqual([]);
    });

    it("at its deadline cancels the rest, reads it again, and records what filled up to the cancel", async () => {
      const gemini = venue({ orderTtlMs: 60_000 });
      const placed = placedOf(await gemini.placeOrder(order()));
      fake.fill(placed.venueOrderId, 500);
      expect((await gemini.readFill(placed)).state).toBe("open");

      // Two more contracts fill after the venue's read and before its cancel reaches Gemini.
      fake.beforeRequest = (route) => {
        if (route === `POST ${CANCEL_ROUTE}`) {
          fake.beforeRequest = () => {};
          fake.fill(placed.venueOrderId, 200);
        }
      };
      clock.now += 61_000;
      expect(await gemini.readFill(placed)).toEqual({
        state: "closed",
        filledCents: 217,
        detail: "7 of 40 contracts filled on Gemini's sandbox, the rest cancelled",
      });
      expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(1);
      expect(journal.records.get(7)).toMatchObject({ state: "partly_filled", filledHundredths: 700 });
      // Nothing said "cancelled" before Gemini acknowledged the cancel.
      expect(cancelWording()).toHaveLength(1);
    });

    it("after a restart, closes it as filled when Gemini filled the rest while no executor was running", async () => {
      const gemini = venue();
      const placed = placedOf(await gemini.placeOrder(order()));
      fake.fill(placed.venueOrderId, 500);
      expect((await gemini.readFill(placed)).state).toBe("open");

      fake.fill(placed.venueOrderId);
      const again = restarted();
      expect(await again.readFill(placed)).toEqual({
        state: "closed",
        filledCents: 1_240,
        detail: "filled on Gemini's sandbox",
      });
      expect(journal.records.get(7)).toMatchObject({ state: "filled", filledHundredths: 4_000 });
      expect(cancelWording()).toEqual([]);
    });

    it("after a restart, finds a lost attempt partly filled and still working, and follows it as open", async () => {
      fake.foreign.push({ symbol: MARKET, outcome: "yes", priceCents: 69, hundredths: 500 });
      fake.failNextPlacement({ kind: "drop-after" });
      const first = venue();
      expect((await first.placeOrder(order())).status).toBe("held");

      const again = restarted();
      const placed = placedOf(await again.placeOrder(order()));
      expect(fake.callsTo(ORDER_ROUTE)).toHaveLength(1);
      expect(journal.records.get(7)).toMatchObject({ state: "open", filledHundredths: 500 });
      expect(await again.readFill(placed)).toEqual({ state: "open", filledCents: 155 });
      expect(cancelWording()).toEqual([]);
    });
  });

  it("cancels a minute before the market stops trading, even before the order's time is up", async () => {
    clock.now = Date.parse("2026-11-20T21:58:00Z");
    const gemini = venue();
    const placed = placedOf(await gemini.placeOrder(order()));
    clock.now = Date.parse("2026-11-20T21:59:00Z");
    await gemini.readFill(placed);
    expect(fake.callsTo(CANCEL_ROUTE)).toHaveLength(1);
    expect(await gemini.readFill(placed)).toMatchObject({ state: "closed", filledCents: 0 });
    expect(journal.records.get(7)?.state).toBe("cancelled");
  });
});

describe("settling a position", () => {
  async function filledOn(market: string, outcome: "YES" | "NO" = "NO") {
    const gemini = venue();
    // Placed while its ladder still traded: the recorded ladders have closed since.
    const now = events;
    events = now.map((event) => ({
      ...event,
      contracts: event.contracts.map((contract) => ({ ...contract, marketState: "open" })),
    }));
    const placement = await gemini.placeOrder(order({ market, outcome })).finally(() => {
      events = now;
    });
    const placed = placedOf(placement);
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

  /** The settled ladder as the sandbox lists it: without HI68000, which only production lists. */
  function sandboxWithout(symbol: string): MarketEvent {
    return { ...SETTLED, contracts: SETTLED.contracts.filter((c) => c.instrumentSymbol !== symbol) };
  }
  const PRODUCTION_ONLY = "GEMI-BTC2611132200-HI68000";

  it("resolves a simulated fill on production, never 'unlisted', when the sandbox does not list its symbol", async () => {
    // Tonight's switch: the 9 intents filled by the simulated venue stay, on strikes the sandbox lacks.
    events = [OPEN, sandboxWithout(PRODUCTION_ONLY)];
    productionEvents = [OPEN, SETTLED];
    const gemini = venue();
    const outcome = await gemini.positionOutcome(position({ market: PRODUCTION_ONLY }));
    // $68,000 and below resolved YES: a NO position there paid nothing.
    expect(outcome).toMatchObject({
      status: "resolved",
      venue: "simulated",
      resolution: "yes",
      contractsHundredths: 4_000,
      payoutCents: 0,
    });
    expect(asked.venue).toEqual([]);
    expect(await gemini.outcomeSource?.(position({ market: PRODUCTION_ONLY }))).toBe("simulated");
  });

  it("resolves a sandbox fill and a simulated fill side by side, each on the exchange that filled it", async () => {
    events = [OPEN, sandboxWithout(PRODUCTION_ONLY)];
    // Production resolves HI68500 the other way, so a sandbox fill read there would settle wrong.
    productionEvents = [
      OPEN,
      {
        ...SETTLED,
        contracts: SETTLED.contracts.map((c) =>
          c.instrumentSymbol === SETTLED_NO ? { ...c, resolutionSide: "yes" } : c,
        ),
      },
    ];
    const gemini = await filledOn(SETTLED_NO); // intent 7, journaled: filled on the sandbox
    fake.settle(SETTLED_NO, "no", "BTC2611132200");
    const sandboxFill = position({ intentId: 7, market: SETTLED_NO });
    const simulatedFill = position({ intentId: 8, market: PRODUCTION_ONLY, costCents: 620, limitPrice: 31 });

    expect(await gemini.positionOutcome(sandboxFill)).toMatchObject({
      status: "resolved",
      resolution: "no",
      contractsHundredths: 4_000,
      payoutCents: 4_000,
      feeCents: 60,
    });
    expect(await gemini.positionOutcome(sandboxFill)).not.toHaveProperty("venue");
    expect(await gemini.positionOutcome(simulatedFill)).toMatchObject({
      status: "resolved",
      venue: "simulated",
      resolution: "yes",
      contractsHundredths: 2_000,
      payoutCents: 0,
    });
    expect(asked.production).toEqual(["BTC2611132200"]);
    expect(await gemini.outcomeSource?.(sandboxFill)).toBe("sandbox");
    expect(await gemini.outcomeSource?.(simulatedFill)).toBe("simulated");
  });

  it("never takes a fill for a simulated one while the order journal cannot be read", async () => {
    const gemini = await filledOn(SETTLED_NO);
    journal.failing = "the console did not answer";
    await expect(gemini.positionOutcome(position())).rejects.toThrow("the console did not answer");
    expect(asked.production).toEqual([]);
  });
});
