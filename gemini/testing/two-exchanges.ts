/**
 * Two Gemini exchanges as they stood on 18 November 2026 at 08:38 UTC, recorded from their public APIs
 * (`gemini/test/fixtures/two-exchanges`): production and the sandbox list different strikes on the same
 * ladders, and every other suite serves one strike set for both, which is how a stack trading on the
 * sandbox read "nothing to cover" for a goal its positions paid in full (the hosted switch of that day).
 *
 * - Weekly BTC2611202200: production lists 21 strikes, HI61000 to HI71000; the sandbox lists 8,
 *   HI67000 to HI70500, every one above spot.
 * - Daily BTC2611182200 (settles 22:00 UTC that day): production lists 12 strikes, the sandbox 6,
 *   HI63000 to HI64250.
 * - Tomorrow's daily BTC2611192200 is listed on neither: its event route answers 404 on both.
 * - Monthly BTC2611302200 is listed on both, as it was.
 *
 * Nothing is shifted: a test pins its clock (`TWO_EXCHANGES_AT`, or `AFTER_DAILY_EXPIRY` for the evening
 * when the daily has expired and tomorrow's is not listed yet), and the listing drops expired ladders by
 * that clock as Gemini's client does.
 *
 * Books: production answers the books recorded for the daily's six sandbox strikes and three weekly ones,
 * and an empty book for any other strike. The sandbox's own books were empty when recorded (its weekly
 * books always were); with `sandboxDailyBooks: "mirrored"` the daily's books are derived from production's
 * as the test market maker (`gemini:maker`) mirrors them: the best bid and best ask, each capped at 100
 * contracts and $50. They are derived, not recorded.
 *
 * Spot is each exchange's own recorded BTC/USD ticker: production's mid is $64,661.73, the sandbox's
 * $64,037.07 (the stack reads production's on every venue).
 *
 * `HOSTED_WEEKLY_PLAN` and `HOSTED_INTENTS` are the hosted mandate's goal and positions at the switch: the
 * weekly plan Grok Bot made at 03:14 UTC (floor $57,991.80, holding 0.05 BTC) and its eight NO buys, all
 * filled by the simulated venue (positions pay $247.63 below $61,000), plus one rejected intent.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { GEMINI_HOSTS, type GeminiEnvironment } from "../src/environment";

const FIXTURES = new URL("../test/fixtures/two-exchanges/", import.meta.url);

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(file, FIXTURES)), "utf8"));
}

/** When both exchanges were recorded. */
export const TWO_EXCHANGES_AT = Date.parse("2026-11-18T08:38:00Z");
export const WEEKLY = "BTC2611202200";
export const DAILY = "BTC2611182200";
export const MONTHLY = "BTC2611302200";
/** Tomorrow's daily: listed on neither exchange when recorded. */
export const TOMORROW_DAILY = "BTC2611192200";
export const WEEKLY_EXPIRY = "2026-11-20T22:00:00.000Z";
export const DAILY_EXPIRY = "2026-11-18T22:00:00.000Z";
/** One minute after the daily expired, with tomorrow's daily still unlisted. */
export const AFTER_DAILY_EXPIRY = Date.parse("2026-11-18T22:01:00Z");

/** The strikes each exchange listed, by ladder. */
export const LISTED = {
  production: {
    [WEEKLY]: [
      61000, 61500, 62000, 62500, 63000, 63500, 64000, 64500, 65000, 65500, 66000, 66500, 67000, 67500, 68000,
      68500, 69000, 69500, 70000, 70500, 71000,
    ],
    [DAILY]: [63000, 63250, 63500, 63750, 64000, 64250, 64500, 64750, 65000, 65250, 65500, 65750],
  },
  sandbox: {
    [WEEKLY]: [67000, 67500, 68000, 68500, 69000, 69500, 70000, 70500],
    [DAILY]: [63000, 63250, 63500, 63750, 64000, 64250],
  },
} as const;

export interface TwoExchangeOptions {
  /** The sandbox daily's books: "empty" as recorded (the default), or "mirrored" from production's. */
  sandboxDailyBooks?: "empty" | "mirrored";
  /**
   * Ladders the sandbox does not list at all (404, and left out of its listing), as when it lacks a
   * ladder production lists. Not recorded: a variation for the "ladder not listed" cause.
   */
  sandboxUnlisted?: readonly string[];
  /**
   * BTC/USD on both exchanges, in dollars, as bid, ask and last alike: for a price the recording did not
   * see, such as a fall through a goal's floor. Not recorded. Default: as recorded.
   */
  spotUsd?: number;
}

interface Listing {
  data: { ticker: string }[];
  pagination: { limit: number; offset: number; total: number };
}

interface BookLevel {
  price: string;
  amount: string;
  timestamp: string;
}

interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
}

const EVENT_ROUTE = "/v1/prediction-markets/events/";
const LIST_ROUTE = "/v1/prediction-markets/events";
const BOOK_ROUTE = "/v1/book/";
const EMPTY_BOOK: Book = { bids: [], asks: [] };
const MAKER_MAX_CONTRACTS = 100;
const MAKER_MAX_USD = 50;

function listing(environment: GeminiEnvironment, options: TwoExchangeOptions = {}): Listing {
  const recorded = readFixture(`${environment}/events-btc.json`) as Listing;
  if (environment !== "sandbox" || !options.sandboxUnlisted?.length) return recorded;
  const unlisted = new Set(options.sandboxUnlisted);
  const data = recorded.data.filter((event) => !unlisted.has(event.ticker));
  return { data, pagination: { ...recorded.pagination, total: data.length } };
}

function recordedBook(environment: GeminiEnvironment, symbol: string): Book | null {
  try {
    return readFixture(`${environment}/book-${symbol}.json`) as Book;
  } catch {
    return null;
  }
}

/** One level as the maker quotes it: at most 100 contracts and $50. */
function capped(level: BookLevel): BookLevel {
  const price = Number(level.price);
  const byUsd = Math.floor((MAKER_MAX_USD / price) * 100) / 100;
  const amount = Math.min(Number(level.amount), MAKER_MAX_CONTRACTS, byUsd);
  return { ...level, amount: String(amount) };
}

function book(environment: GeminiEnvironment, symbol: string, options: TwoExchangeOptions): Book {
  if (environment === "production") return recordedBook("production", symbol) ?? EMPTY_BOOK;
  if (options.sandboxDailyBooks !== "mirrored" || !symbol.startsWith(`GEMI-${DAILY}-`)) return EMPTY_BOOK;
  const listed = (listing("sandbox").data as { ticker: string; contracts?: { instrumentSymbol: string }[] }[])
    .find((event) => event.ticker === DAILY)
    ?.contracts?.some((contract) => contract.instrumentSymbol === symbol);
  const mirrored = listed ? recordedBook("production", symbol) : null;
  if (!mirrored) return EMPTY_BOOK;
  return {
    bids: mirrored.bids.slice(0, 1).map(capped),
    asks: mirrored.asks.slice(0, 1).map(capped),
  };
}

/**
 * What one exchange answers for a GET path, as `{ status, body }`. The listing answers every query (both
 * listings fit in one page) with the events not yet expired at `now`.
 */
export function twoExchangeResponse(
  environment: GeminiEnvironment,
  path: string,
  now: number,
  options: TwoExchangeOptions = {},
): { status: number; body: unknown } {
  const route = decodeURIComponent(path.split("?")[0] ?? "");
  if (route === LIST_ROUTE) {
    const { data } = listing(environment, options);
    const open = data.filter(
      (event) => Date.parse((event as { expiryDate?: string }).expiryDate ?? "") > now,
    );
    return { status: 200, body: { data: open, pagination: { limit: 100, offset: 0, total: open.length } } };
  }
  if (route.startsWith(EVENT_ROUTE)) {
    const ticker = route.slice(EVENT_ROUTE.length);
    const event = listing(environment, options).data.find((candidate) => candidate.ticker === ticker);
    return event
      ? { status: 200, body: event }
      : { status: 404, body: { result: "error", reason: "NotFound", message: `Event ${ticker} not found` } };
  }
  if (route.startsWith(BOOK_ROUTE)) {
    return { status: 200, body: book(environment, route.slice(BOOK_ROUTE.length), options) };
  }
  if (route === "/v1/pubticker/btcusd") {
    const recorded = readFixture(`${environment}/pubticker-btcusd.json`) as Record<string, unknown>;
    if (options.spotUsd === undefined) return { status: 200, body: recorded };
    const at = options.spotUsd.toFixed(2);
    return { status: 200, body: { ...recorded, bid: at, ask: at, last: at } };
  }
  return { status: 404, body: { result: "error", reason: "NotFound" } };
}

/** The exchange a URL names: Gemini's two hosts by name. */
function environmentOf(url: URL): GeminiEnvironment | null {
  if (url.origin === GEMINI_HOSTS.production) return "production";
  if (url.origin === GEMINI_HOSTS.sandbox) return "sandbox";
  return null;
}

/**
 * A `fetch` that answers for both of Gemini's real hosts (`GEMINI_HOSTS`), each with its own recording,
 * and records every request as "<environment> <path>". Anything else is refused: no request leaves.
 */
export function twoExchangeFetch(
  now: () => number,
  options: TwoExchangeOptions = {},
): { fetch: (input: string | URL | Request) => Promise<Response>; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const environment = environmentOf(url);
    if (environment === null)
      return Promise.reject(new Error(`two-exchanges fixture: no host ${url.origin}`));
    const path = `${url.pathname}${url.search}`;
    requests.push(`${environment} ${path}`);
    const { status, body } = twoExchangeResponse(environment, path, now(), options);
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch: fetchImpl, requests };
}

export interface TwoExchangeServers {
  /** Stands in for each exchange's host on a loopback port. */
  urls: Record<GeminiEnvironment, string>;
  requests: string[];
  stop(): Promise<void>;
}

/** The two exchanges on two loopback ports, for clients that need real HTTP. GET only. */
export async function startTwoExchanges(
  now: () => number,
  options: TwoExchangeOptions = {},
): Promise<TwoExchangeServers> {
  const requests: string[] = [];
  const servers: Server[] = [];
  const urls = {} as Record<GeminiEnvironment, string>;
  for (const environment of ["production", "sandbox"] as const) {
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      requests.push(`${environment} ${path}`);
      const { status, body } =
        request.method === "GET"
          ? twoExchangeResponse(environment, path, now(), options)
          : { status: 405, body: { result: "error", reason: "MethodNotAllowed" } };
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    servers.push(server);
    urls[environment] = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }
  return {
    urls,
    requests,
    stop: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => {
                resolve();
              });
            }),
        ),
      ).then(() => undefined),
  };
}

/** The hosted mandate's weekly plan at the switch, as the console stored it. */
export interface HostedPlanRecord {
  plan_id: string;
  asset: string;
  request_text: string;
  created_at: string;
  stored_at: string;
  plan: Record<string, unknown> & {
    planId: string;
    eventTicker: string;
    expiry: string;
    floorCents: number | null;
    ceilingCents: number | null;
    spotCents: number;
    holdingQuantity: string;
  };
}

export const HOSTED_WEEKLY_PLAN = readFixture("hosted-weekly-plan.json") as HostedPlanRecord;

/** The hosted mandate's holding, as saved at 03:10 UTC. */
export const HOSTED_HOLDING = { asset: "BTC", quantity: "0.05" } as const;

/** One intent as the cover reads it (`@mandate/planner`'s `RecordedIntent`). */
export interface HostedIntent {
  id: number;
  market: string | null;
  outcome: string | null;
  isBuy: boolean | null;
  amountCents: number | null;
  limitPrice: number | null;
  status: string;
  filledCents: number | null;
}

const executed = (id: number, strike: string, cents: number, limitPrice: number): HostedIntent => ({
  id,
  market: `GEMI-${WEEKLY}-${strike}`,
  outcome: "NO",
  isBuy: true,
  amountCents: cents,
  limitPrice,
  status: "executed",
  filledCents: cents,
});

/**
 * The hosted mandate's intents at the switch: the plan's seven NO buys (#0 to #6), a later one on HI63000
 * (#7), every one filled in full by the simulated venue, and #8 rejected (over the max trade size).
 */
export const HOSTED_INTENTS: readonly HostedIntent[] = [
  executed(0, "HI64000", 980, 45),
  executed(1, "HI63500", 900, 36),
  executed(2, "HI63000", 700, 28),
  executed(3, "HI62500", 575, 23),
  executed(4, "HI62000", 475, 19),
  executed(5, "HI61500", 350, 14),
  executed(6, "HI61000", 300, 12),
  executed(7, "HI63000", 2200, 29),
  { ...executed(8, "HI62000", 3000, 19), status: "rejected", filledCents: null },
];
