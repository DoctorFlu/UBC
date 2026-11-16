/**
 * A local stand-in for Gemini's public REST API, for the end-to-end tests: it answers the read-only
 * routes the console uses from the responses recorded in gemini/test/fixtures, so no test touches the
 * network. Every timestamp in a response is moved forward by the whole days since the recording, so the
 * recording reads as if it were made today and "the soonest weekly ladder" keeps existing whatever day
 * the suite runs.
 */
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Ladder, createGeminiClient } from "@mandate/gemini";
import { type HedgePlan, type PaidSignal, planHedge } from "@mandate/planner";

const FIXTURES = fileURLToPath(new URL("../../../gemini/test/fixtures/", import.meta.url));

/** When the fixtures were recorded (see signals/src/testing.ts). */
const RECORDED_AT = Date.parse("2026-11-15T20:19:00Z");
const DAY_MS = 86_400_000;

/** The recorded weekly BTC ladder the e2e plans are made on. */
export const RECORDED_EVENT = "BTC2611202200";

const ROUTES: Record<string, string> = {
  [`/v1/prediction-markets/events/${RECORDED_EVENT}`]: `event-${RECORDED_EVENT}.json`,
  "/v1/pubticker/btcusd": "pubticker-btcusd.json",
};

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

/** The recorded body for a path, dates moved as described above, or null for a route it does not know. */
export function recordedResponse(path: string, now = Date.now()): unknown {
  const file = path.startsWith("/v1/prediction-markets/events?")
    ? "events-crypto.json"
    : ROUTES[path.split("?")[0] ?? ""];
  if (!file) return null;
  const shiftMs = Math.max(0, Math.floor((now - RECORDED_AT) / DAY_MS)) * DAY_MS;
  return shiftDates(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")), shiftMs);
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
  requests: string[];
  stop: () => Promise<void>;
}

export async function startFakeGemini(port: number): Promise<FakeGemini> {
  let failing = false;
  const requests: string[] = [];
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
    const body = request.method === "GET" ? recordedResponse(path) : null;
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
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
