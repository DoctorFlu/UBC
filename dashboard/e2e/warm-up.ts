import type { FullConfig } from "@playwright/test";

import { AGENT_ADDRESS, routes } from "./routes";
import { announceAgent, decisionContext, sealReason, waitForSnapshot } from "./support/console";

/** Intents the demo seed proposes (support/chain.ts `seedDemo`). */
const DEMO_INTENTS = 7;

/**
 * Runs once the demo chain and the console are up (the live suite starts its own and skips this):
 * 1. Waits until the console has read the whole demo history from the chain.
 * 2. Plays the agent's MCP server once: announces the agent and seals the reason for intent 0.
 * 3. `next dev` compiles each route on its first request. Tests that hit a cold route in parallel can
 *    wait long enough for Chrome to log "preloaded but not used" warnings, which the smoke test rightly
 *    treats as failures. Compiling every route once, in order, before the tests removes that.
 */
export default async function warmUp(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL || process.env.E2E_SUITE === "live") return;
  const ready = await waitForSnapshot(
    baseURL,
    (snapshot) => snapshot.feed.health === "live" && (snapshot.chain?.intents.length ?? 0) >= DEMO_INTENTS,
    120_000,
  );
  await announceAgent(baseURL, AGENT_ADDRESS);
  const first = ready.chain?.intents[0];
  if (first) {
    await sealReason(
      baseURL,
      first.id,
      first.proposedTxHash,
      decisionContext(
        "The $65,000 rung pays first if BTC falls this week, and costs the least per dollar covered.",
      ),
    );
  }
  for (const route of routes) {
    const response = await fetch(new URL(route.path, baseURL));
    await response.arrayBuffer();
  }
}
