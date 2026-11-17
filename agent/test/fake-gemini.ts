/**
 * A fake of Gemini's public market-data API over real HTTP, for tests that need the real Gemini
 * client (`createGeminiMarkets({ baseUrl })`) with its timeouts, retries, pacing and cache.
 *
 * It serves the recorded BTC ladder fixture, its order books and a BTC spot price. Any path that
 * starts with one of `stalled` is accepted and never answered, like an endpoint that hangs; the
 * fake notes when the client gives up on it (the socket closes).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const FIXTURES = new URL("../../gemini/test/fixtures/", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8");

/** The recorded ladder (strikes from $61,000 to $71,000, settling 2026-11-20 22:00 UTC). */
export const FAKE_GEMINI_TICKER = "BTC2611202200";

export interface FakeGeminiRequest {
  path: string;
  /** `performance.now()` when the request arrived. */
  at: number;
  /** When the fake answered it, or null for a stalled request. */
  answeredAt: number | null;
  /** When the client closed a request the fake never answered, or null. */
  closedAt: number | null;
}

export interface FakeGemini {
  readonly url: string;
  /** Path prefixes that are accepted and never answered. */
  readonly stalled: Set<string>;
  readonly requests: FakeGeminiRequest[];
  /** Stalled requests whose socket is still open. */
  openStalls(): number;
  close(): Promise<void>;
}

export async function startFakeGemini(options: { spot?: string } = {}): Promise<FakeGemini> {
  const event = read(`event-${FAKE_GEMINI_TICKER}.json`);
  const book = read(`book-GEMI-${FAKE_GEMINI_TICKER}-HI61000.json`);
  const spot = options.spot ?? "64140.00";
  const ticker = JSON.stringify({ bid: spot, ask: spot, last: spot });
  const stalled = new Set<string>();
  const requests: FakeGeminiRequest[] = [];
  const hanging = new Set<ServerResponse>();

  const answer = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    const entry: FakeGeminiRequest = { path, at: performance.now(), answeredAt: null, closedAt: null };
    requests.push(entry);
    if ([...stalled].some((prefix) => path.startsWith(prefix))) {
      hanging.add(res);
      res.on("close", () => {
        hanging.delete(res);
        entry.closedAt = performance.now();
      });
      return;
    }
    entry.answeredAt = performance.now();
    if (path === `/v1/prediction-markets/events/${FAKE_GEMINI_TICKER}`) {
      answer(res, 200, event);
      return;
    }
    if (path === "/v1/pubticker/btcusd") {
      answer(res, 200, ticker);
      return;
    }
    if (path.startsWith(`/v1/book/GEMI-${FAKE_GEMINI_TICKER}-`)) {
      answer(res, 200, book);
      return;
    }
    answer(res, 404, JSON.stringify({ result: "error", reason: "NotFound" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port.toString()}`,
    stalled,
    requests,
    openStalls: () => hanging.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
