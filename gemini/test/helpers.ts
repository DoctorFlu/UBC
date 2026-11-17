import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGeminiClient, type FetchLike, type GeminiClientOptions } from "../src/index";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** When the live fixtures were recorded (all crypto ladders in them are still open). */
export const RECORDED_AT = Date.parse("2026-11-15T20:19:00Z");

/** A clock that only moves when the code under test sleeps. */
export function fakeClock(start = RECORDED_AT) {
  const clock = {
    now: start,
    sleeps: [] as number[],
    read: () => clock.now,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A fetch that routes by path prefix and records every request path. Routes are tried in
 * order; the first matching prefix answers.
 */
export function routedFetch(routes: [prefix: string, handler: Handler][]) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname + url.search;
    calls.push(path);
    for (const [prefix, handler] of routes) {
      if (path.startsWith(prefix)) return handler(path, init);
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch: fetchImpl, calls };
}

/** The recorded crypto API: events page, one event, books, the BTC spot ticker and hourly BTC candles. */
export function recordedApi() {
  const page = fixture("events-crypto.json") as { data: { ticker: string }[] };
  return routedFetch([
    ["/v1/prediction-markets/events?", () => json(page)],
    ["/v1/prediction-markets/events/recently-settled", () => json(fixture("recently-settled-crypto.json"))],
    ["/v1/prediction-markets/events/BTC2611202200", () => json(fixture("event-BTC2611202200.json"))],
    [
      "/v1/prediction-markets/events/",
      (path) => {
        const event = page.data.find((e) => path.endsWith(`/${e.ticker}`));
        return event === undefined ? json({ error: "Event not found" }, 404) : json(event);
      },
    ],
    ["/v1/book/", () => json(fixture("book-GEMI-BTC2611202200-HI61000.json"))],
    ["/v1/pubticker/btcusd", () => json(fixture("pubticker-btcusd.json"))],
    ["/v2/candles/btcusd/1hr", () => json(fixture("candles-btcusd-1hr.json"))],
  ]);
}

export function testClient(fetchImpl: FetchLike, clock = fakeClock(), extra: GeminiClientOptions = {}) {
  return createGeminiClient({
    fetch: fetchImpl,
    now: clock.read,
    sleep: clock.sleep,
    random: () => 0.5,
    ...extra,
  });
}

/** One request a loopback test server received. */
export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

async function listen(handle: (request: Received) => { status: number; headers?: Record<string, string> }) {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const seen = { method: request.method ?? "", url: request.url ?? "", headers: request.headers };
    received.push(seen);
    const answer = handle(seen);
    response.writeHead(answer.status, answer.headers);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    host: `127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Two real loopback HTTP servers: `redirecting` answers every request with `status` and a `Location` on
 * `target`, which answers 200 and records what reaches it. A signed client must leave `target` untouched.
 */
export async function redirectingPair(status: number) {
  const target = await listen(() => ({ status: 200, headers: { "content-type": "application/json" } }));
  const redirecting = await listen((request) => ({
    status,
    headers: { location: `${target.url}${request.url}` },
  }));
  return {
    redirecting,
    target,
    close: async () => {
      await Promise.all([redirecting.close(), target.close()]);
    },
  };
}
