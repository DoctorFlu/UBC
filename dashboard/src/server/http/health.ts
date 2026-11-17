import "server-only";

import type { GeminiEnvironment, MarketDataSource } from "@mandate/gemini";

import type { FeedHealth } from "@/lib/live/types";

import type { ConsoleService } from "../console-service";
import { apiError, json } from "./responses";

export interface HealthResponse {
  status: "ok";
  /** Whether the backend is following the chain. Informational: a console with the chain down still serves. */
  feed: FeedHealth;
  /**
   * Which Gemini the console reads market data from (`marketDataSource`). The MCP server checks it agrees
   * with its own before proposing onchain. Public: the Sandbox badge says as much on every page.
   */
  marketEnvironment: GeminiEnvironment;
}

/**
 * GET /api/health: the console is up and its backend is running. The container's health check and the
 * hosting smoke test call it, and it is public behind the reverse proxy, so it says nothing about the
 * mandate, the owner or the agent: only the state of the chain feed, which every console page shows, and
 * which Gemini environment it reads. Settings that contradict each other (`marketDataSource` throws) make
 * it answer 503, so the container never turns healthy and the MCP server, which waits on it, never starts;
 * the reason, naming the settings, goes to the console's log, not to the public answer.
 */
export function health(
  service: Pick<ConsoleService, "snapshot">,
  marketData: () => Pick<MarketDataSource, "environment">,
): Response {
  let marketEnvironment: GeminiEnvironment;
  try {
    marketEnvironment = marketData().environment;
  } catch (error) {
    console.error(`[console] ${error instanceof Error ? error.message : String(error)}`);
    return apiError(
      503,
      "market_data_misconfigured",
      "The console's Gemini settings contradict each other; its log names them.",
    );
  }
  const body: HealthResponse = { status: "ok", feed: service.snapshot().feed.health, marketEnvironment };
  return json(body);
}
