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
