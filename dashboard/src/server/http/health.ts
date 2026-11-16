import "server-only";

import type { FeedHealth } from "@/lib/live/types";

import type { ConsoleService } from "../console-service";
import { json } from "./responses";

export interface HealthResponse {
  status: "ok";
  /** Whether the backend is following the chain. Informational: a console with the chain down still serves. */
  feed: FeedHealth;
}

/**
 * GET /api/health: the console is up and its backend is running. The container's health check and the
 * hosting smoke test call it, and it is public behind the reverse proxy, so it says nothing about the
 * mandate, the owner or the agent: only the state of the chain feed, which every console page shows.
 */
export function health(service: Pick<ConsoleService, "snapshot">): Response {
  const body: HealthResponse = { status: "ok", feed: service.snapshot().feed.health };
  return json(body);
}
