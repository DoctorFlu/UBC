/**
 * Talking to a running console from the end-to-end tests: the agent API (as the MCP server would, with
 * the service token) and the snapshot the browser receives.
 */
import { type DecisionContext, CONSOLE_AGENT_ROUTES, hashContext } from "@mandate/shared";
import type { Hex } from "viem";

import type { ConsoleSnapshot } from "../../src/lib/live/types";

/** A test-only token: the e2e servers are local and short-lived. Never a real secret. */
export const E2E_SERVICE_TOKEN = "e2e-console-service-token-for-local-tests-only";

export const AGENT_NAME = "Grok Bot";

export async function agentApi(
  baseURL: string,
  path: string,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
) {
  const response = await fetch(new URL(path, baseURL), {
    method,
    headers: {
      authorization: `Bearer ${E2E_SERVICE_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status.toString()}: ${await response.text()}`);
  }
  return (await response.json()) as unknown;
}

export async function snapshot(baseURL: string): Promise<ConsoleSnapshot> {
  const response = await fetch(new URL("/api/console/snapshot", baseURL));
  if (!response.ok) throw new Error(`snapshot answered ${response.status.toString()}`);
  return (await response.json()) as ConsoleSnapshot;
}

/** Polls the snapshot until `ready` accepts it. */
export async function waitForSnapshot(
  baseURL: string,
  ready: (snapshot: ConsoleSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<ConsoleSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const current = await snapshot(baseURL);
      if (ready(current)) return current;
      last = current.feed;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the console did not reach the expected state; last feed: ${JSON.stringify(last)}`);
}

export async function announceAgent(baseURL: string, agentAddress: string): Promise<void> {
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.pairing, "PUT", {
    agentAddress,
    agentName: AGENT_NAME,
    serverVersion: "0.1.0",
  });
}

export function decisionContext(reason: string): DecisionContext {
  return {
    version: 1,
    requestText: "Protect my 0.05 BTC below $65,000 this week.",
    planId: "plan_e2e",
    rungIndex: 0,
    ladderSummary: {
      eventTicker: "BTC2611202200",
      observedAt: "2026-11-15T13:24:30.000Z",
      rungs: [
        {
          instrumentSymbol: "GEMI-BTC2611202200-HI66000",
          label: "$66,000 or above",
          yesBidCents: 41,
          yesAskCents: 43,
        },
        {
          instrumentSymbol: "GEMI-BTC2611202200-HI65000",
          label: "$65,000 or above",
          yesBidCents: 68,
          yesAskCents: 69,
        },
        {
          instrumentSymbol: "GEMI-BTC2611202200-HI64000",
          label: "$64,000 or above",
          yesBidCents: 84,
          yesAskCents: null,
        },
      ],
    },
    signalReceiptIds: [],
    reason,
    createdAt: "2026-11-15T13:24:40.000Z",
  };
}

/** The receipt id of the signal payment the demo agent made. */
export const DEMO_RECEIPT = `0x${"5d".repeat(32)}`;

/** Plays the MCP server reporting one signal purchase (amounts in USDC atomic units). */
export async function recordSignalPayment(
  baseURL: string,
  receiptId: string,
  paidAt: string,
  payer: string,
): Promise<void> {
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.signalPayment(receiptId), "PUT", {
    amount: "1000",
    paidAt,
    resource: "/v1/signal/hedge?asset=BTC&horizon=weekly",
    network: "eip155:5042002",
    payer,
    payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    settlementId: "9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f",
    signal: {
      signalId: `0x${"4e".repeat(32)}`,
      asset: "BTC",
      eventTicker: "BTC2611202200",
      horizon: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      asOf: paidAt,
      counts: { cheap: 3, fair: 15, expensive: 3, noOffer: 0 },
    },
  });
}

/** Plays the MCP server reporting its signal budget for today. */
export async function reportSignalBudget(
  baseURL: string,
  buyerAddress: string,
  overrides: { spentToday?: string; resetsAt?: string } = {},
): Promise<void> {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.signalBudget, "PUT", {
    buyerAddress,
    day: now.toISOString().slice(0, 10),
    dailyBudget: "20000",
    spentToday: overrides.spentToday ?? "1000",
    maxPricePerPurchase: "5000",
    resetsAt: overrides.resetsAt ?? tomorrow.toISOString(),
    gatewayBalance: "4999000",
    asOf: now.toISOString(),
  });
}

/** Stores the agent's decision context, then links it to the intent its transaction proposed. */
export async function sealReason(
  baseURL: string,
  intentId: number,
  proposedTxHash: Hex,
  document: DecisionContext,
): Promise<Hex> {
  const hash = hashContext(document);
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.context(hash), "PUT", { document });
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.intentContext(intentId), "PUT", {
    hash,
    txHash: proposedTxHash,
  });
  return hash;
}
