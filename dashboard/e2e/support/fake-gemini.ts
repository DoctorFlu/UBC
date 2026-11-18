/**
 * A local stand-in for Gemini's public REST API, for the end-to-end tests: it answers the read-only
 * routes the console uses from the responses recorded in gemini/test/fixtures, so no test touches the
 * network. Every timestamp in a response is moved forward by the whole days since the recording, so the
 * recording reads as if it were made today and "the soonest weekly ladder" keeps existing whatever day
 * the suite runs.
 */
import { type Server, createServer } from "node:http";

import { type Ladder, createGeminiClient } from "@mandate/gemini";
import { type ExtraEvent, RECORDED_EVENT, recordedResponse as replay } from "@mandate/gemini/recorded";
import { type HedgePlan, type PaidSignal, planHedge } from "@mandate/planner";

export { RECORDED_EVENT };

const EVENT_ROUTE = "/v1/prediction-markets/events/";

/** A Sports market, for the test that sends it with the Crypto category. */
export const SPORTS_MARKET = "GEMI-NFL-2611152125-SF-DAL-M-SF";

/**
 * Markets the e2e chain uses that the recordings lack, listed as Gemini lists them, so the console's
 * listing check flags only what a test means it to. Each is added to the recorded event of that ticker,
 * or makes an event of its own.
 */
const EXTRA_EVENTS: Record<string, ExtraEvent> = {
  // The demo seed's ETH order sits on the recorded ETH ladder, at a strike the recording lacks.
  ETH2611202200: {
    title: "ETH price on November 20",
    category: "Crypto",
    contracts: [["HI2800", "$2,800 or above"]],
  },
  NBA2611200100: {
    title: "Los Angeles L vs Boston",
    category: "Sports",
    contracts: [["HILAL", "Los Angeles L"]],
  },
  "NFL-2611152125-SF-DAL-M": {
    title: "San Francisco vs Dallas",
    category: "Sports",
    contracts: [["SF", "San Francisco"]],
  },
};

/** The recorded body for a path, with the markets above, dates moved to today; null for an unknown route. */
export function recordedResponse(path: string, now = Date.now()): unknown {
  return replay(path, now, { extraEvents: EXTRA_EVENTS });
}

/** The port the smoke and screenshot suites serve it on (the live suite starts its own). */
export const SUITE_GEMINI_PORT = Number(process.env.E2E_GEMINI_PORT ?? 8655);

/** The recorded ladder, read through the real client exactly as the console reads it from the fake. */
export async function recordedLadder(asset = "BTC"): Promise<Ladder> {
  const client = createGeminiClient({
    baseUrl: "https://gemini.recorded",
    fetch: (input) => {
      const url = new URL(input);
      const body = recordedResponse(`${url.pathname}${url.search}`);
      return Promise.resolve(body === null ? new Response("{}", { status: 404 }) : Response.json(body));
    },
  });
  return client.getLadder({ asset, horizon: "weekly" });
}

/**
 * The plan the agent's MCP server would post for `quantity` BTC on the recorded ladder, as the
 * POST /api/agent/v1/plans body. Same planner, same inputs, so the console must show these numbers.
 */
export async function recordedPlanRequest(options: {
  quantity: string;
  dropPercent: number;
  maxCostCents: number;
  maxTradeCents: number;
  remainingBudgetCents: number;
  requestText: string;
  /** A paid signal to plan with, as the agent passes the one it bought. */
  signal?: PaidSignal;
}): Promise<{ planId: string; asset: string; requestText: string; createdAt: string; plan: HedgePlan }> {
  const plan = planHedge({
    holding: { asset: "BTC", quantity: options.quantity },
    ladder: await recordedLadder(),
    goal: { dropPercent: options.dropPercent },
    maxCostCents: options.maxCostCents,
    limits: {
      maxTradeCents: options.maxTradeCents,
      remainingBudgetCents: options.remainingBudgetCents,
      categoryAllowed: true,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    planId: plan.planId,
    asset: plan.asset,
    requestText: options.requestText,
    createdAt: new Date().toISOString(),
    plan,
  };
}

/**
 * A paid hedge signal for the recorded ladder, under `receiptId`: its model values each strike's NO
 * contract one cent above the recorded NO ask, about the planner's limit price, so every rung rates
 * fair and the signal changes no order.
 */
export async function recordedSignal(receiptId: string): Promise<PaidSignal> {
  const ladder = await recordedLadder();
  return {
    receiptId,
    signal: {
      signalId: `0x${"4e".repeat(32)}`,
      asset: ladder.asset,
      eventTicker: ladder.eventTicker,
      model: { fairBandBps: 300 },
      strikes: ladder.rungs.flatMap((rung) =>
        rung.noBuyCents === null
          ? []
          : [{ strikeCents: rung.strikeCents, modelYesBps: 10_000 - (rung.noBuyCents + 1) * 100 }],
      ),
    },
  };
}

export interface FakeGemini {
  url: string;
  /** Answer every request with 503, as if Gemini were down. */
  setFailing: (failing: boolean) => void;
  /** BTC spot in cents, bid and ask both, in place of the recorded one; null restores the recording. */
  setBtcSpot: (cents: number | null) => void;
  /**
   * Moves an event past its expiry, as Gemini shows it once the index settled at `settlementValue`
   * dollars: expired a minute ago, every strike resolved YES at or above the value and NO below it, with
   * the value and the time of each outcome. `published: false` expires it without an outcome yet, as in
   * the minutes between expiry and Gemini publishing it.
   */
  settle: (ticker: string, settlementValue: string, options?: { published?: boolean }) => void;
  requests: string[];
  stop: () => Promise<void>;
}

interface Settled {
  value: string;
  published: boolean;
  expiredAt: string;
  resolvedAt: string;
}

/** An event body as it reads after `settle`: Gemini's own shape (see event-BTC2611132200-settled.json). */
function settledBody(body: unknown, settled: Settled): unknown {
  if (body === null || typeof body !== "object") return body;
  const event = body as Record<string, unknown>;
  const value = Number(settled.value);
  const contracts = Array.isArray(event.contracts) ? (event.contracts as Record<string, unknown>[]) : [];
  return {
    ...event,
    status: settled.published ? "settled" : "active",
    expiryDate: settled.expiredAt,
    ...(settled.published ? { resolvedAt: settled.resolvedAt, settlement: { value: settled.value } } : {}),
    contracts: contracts.map((contract) => {
      const strike = Number((contract.strike as { value?: string } | undefined)?.value ?? Number.NaN);
      const expired = { ...contract, expiryDate: settled.expiredAt, marketState: "closed", prices: {} };
      if (!settled.published || Number.isNaN(strike)) return expired;
      return {
        ...expired,
        status: "settled",
        resolutionSide: value >= strike ? "yes" : "no",
        resolvedAt: settled.resolvedAt,
        settlementValue: settled.value,
      };
    }),
  };
}

export async function startFakeGemini(port: number): Promise<FakeGemini> {
  let failing = false;
  let btcSpot: number | null = null;
  const requests: string[] = [];
  const settledEvents = new Map<string, Settled>();
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (failing) {
      send(503, { result: "error", reason: "Maintenance" });
      return;
    }
    let body = request.method === "GET" ? recordedResponse(path) : null;
    const route = path.split("?")[0] ?? "";
    if (btcSpot !== null && body !== null && route === "/v1/pubticker/btcusd") {
      const price = (btcSpot / 100).toFixed(2);
      body = { ...(body as Record<string, unknown>), bid: price, ask: price, last: price };
    }
    const settled = route.startsWith(EVENT_ROUTE)
      ? settledEvents.get(decodeURIComponent(route.slice(EVENT_ROUTE.length)))
      : undefined;
    if (settled && body !== null) body = settledBody(body, settled);
    if (body === null) send(404, { result: "error", reason: "NotFound" });
    else send(200, body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port.toString()}`,
    setFailing: (next) => {
      failing = next;
    },
    setBtcSpot: (cents) => {
      btcSpot = cents;
    },
    settle: (ticker, value, options = {}) => {
      const now = Date.now();
      settledEvents.set(ticker, {
        value,
        published: options.published ?? true,
        expiredAt: new Date(now - 60_000).toISOString(),
        resolvedAt: new Date(now - 51_768).toISOString(),
      });
    },
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
