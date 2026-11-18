/**
 * Gemini's public REST API, replayed from the responses recorded in `gemini/test/fixtures`: the crypto
 * listing, the weekly BTC ladder, its order books and BTC spot. Every timestamp in a response is moved
 * forward by the whole days since the recording, so the recording reads as if it were made today and "the
 * soonest weekly ladder" keeps existing whatever day it runs.
 *
 * The console's end-to-end suites serve it to the console (`dashboard/e2e/support/fake-gemini.ts`), and
 * `npm run mcp:e2e` serves it to the MCP server when live Gemini is unavailable (`./live-gemini.ts`).
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const FIXTURES = new URL("../test/fixtures/", import.meta.url);

/** When the fixtures were recorded (see signals/src/testing.ts). */
export const RECORDED_AT = Date.parse("2026-11-15T20:19:00Z");
const DAY_MS = 86_400_000;

/** The recorded weekly BTC ladder. */
export const RECORDED_EVENT = "BTC2611202200";
/** Its expiry as recorded, before the shift. */
export const RECORDED_EXPIRY = "2026-11-20T22:00:00.000Z";

const EVENT_ROUTE = "/v1/prediction-markets/events/";
const ROUTES: Record<string, string> = {
  [`${EVENT_ROUTE}${RECORDED_EVENT}`]: `event-${RECORDED_EVENT}.json`,
  "/v1/pubticker/btcusd": "pubticker-btcusd.json",
};
/** Every strike's book answers with the recorded book of one rung. */
const BOOK_ROUTE = `/v1/book/GEMI-${RECORDED_EVENT}-`;
const BOOK = `book-GEMI-${RECORDED_EVENT}-HI61000.json`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function shiftDates(value: unknown, shiftMs: number): unknown {
  if (shiftMs === 0) return value;
  if (typeof value === "string" && ISO.test(value))
    return new Date(Date.parse(value) + shiftMs).toISOString();
  if (Array.isArray(value)) return value.map((item) => shiftDates(item, shiftMs));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftDates(item, shiftMs)]));
  }
  return value;
}

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(file, FIXTURES)), "utf8"));
}

/** A market the recordings lack, listed as Gemini lists it: added to the event of its ticker, or its own. */
export interface ExtraEvent {
  title: string;
  category: string;
  contracts: [ticker: string, label: string][];
}

/** One event as `GET /v1/prediction-markets/events/:ticker` returns it, or null when Gemini lists none. */
function eventBody(ticker: string, extraEvents: Readonly<Record<string, ExtraEvent>>): unknown {
  const recorded = ROUTES[`${EVENT_ROUTE}${ticker}`];
  const listed = (readFixture("events-crypto.json") as { data: { ticker: string }[] }).data.find(
    (event) => event.ticker === ticker,
  );
  const base = (recorded ? readFixture(recorded) : listed) as Record<string, unknown> | undefined;
  const extra = extraEvents[ticker];
  if (!extra) return base ?? null;
  const contracts = extra.contracts.map(([contract, label]) => ({
    instrumentSymbol: `GEMI-${ticker}-${contract}`,
    ticker: contract,
    label,
    status: "active",
    marketState: "open",
    expiryDate: RECORDED_EXPIRY,
  }));
  const event = base ?? {
    id: ticker,
    ticker,
    title: extra.title,
    category: extra.category,
    status: "active",
    expiryDate: RECORDED_EXPIRY,
    contracts: [],
  };
  const existing = Array.isArray(event.contracts) ? (event.contracts as unknown[]) : [];
  return { ...event, contracts: [...existing, ...contracts] };
}

export interface RecordedOptions {
  /** Markets to list beyond the recordings. */
  extraEvents?: Readonly<Record<string, ExtraEvent>>;
  /** Also answer order books (every strike of the recorded ladder gets the one recorded book). */
  books?: boolean;
}

/** The recorded body for a path, dates moved as described above, or null for a route it does not know. */
export function recordedResponse(path: string, now = Date.now(), options: RecordedOptions = {}): unknown {
  const route = path.split("?")[0] ?? "";
  let body: unknown = null;
  if (path.startsWith("/v1/prediction-markets/events?")) body = readFixture("events-crypto.json");
  else if (route.startsWith(EVENT_ROUTE)) {
    body = eventBody(decodeURIComponent(route.slice(EVENT_ROUTE.length)), options.extraEvents ?? {});
  } else if (options.books && route.startsWith(BOOK_ROUTE)) body = readFixture(BOOK);
  else if (ROUTES[route]) body = readFixture(ROUTES[route]);
  if (body === null) return null;
  const shiftMs = Math.max(0, Math.floor((now - RECORDED_AT) / DAY_MS)) * DAY_MS;
  return shiftDates(body, shiftMs);
}

export interface RecordedGemini {
  url: string;
  requests: string[];
  stop(): Promise<void>;
}

/** Serves `recordedResponse` (with books) on a free loopback port, GET only. */
export async function startRecordedGemini(options: RecordedOptions = {}): Promise<RecordedGemini> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const body =
      request.method === "GET" ? recordedResponse(path, Date.now(), { books: true, ...options }) : null;
    response.writeHead(body === null ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { result: "error", reason: "NotFound" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
