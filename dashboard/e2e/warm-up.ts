import type { FullConfig } from "@playwright/test";

import { DEMO_POLICY } from "@mandate/devchain";
import { CONSOLE_AGENT_ROUTES } from "@mandate/shared";

import { AGENT_ADDRESS, routes } from "./routes";
import {
  DEMO_RECEIPT,
  agentApi,
  announceAgent,
  decisionContext,
  recordSignalPayment,
  reportSignalBudget,
  saveHoldingsAsOwner,
  sealReason,
  waitForSnapshot,
} from "./support/console";
import { recordedPlanRequest } from "./support/fake-gemini";

/** Intents the demo seed proposes (support/chain.ts `seedDemo`). */
const DEMO_INTENTS = 7;

/**
 * Runs once the demo chain and the console are up (the live suite starts its own and skips this):
 * 1. Waits until the console has read the whole demo history from the chain.
 * 2. Saves the owner's 0.05 BTC holding (signed with the dev owner key) and plays the agent's MCP server
 *    once: announces the agent, seals the reason for intent 0 and posts a
 *    hedge plan made by the real planner on the recorded Gemini ladder the fake Gemini serves, and
 *    reports one signal payment (cited by intent 0's reason) and its signal budget.
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
    await sealReason(baseURL, first.id, first.proposedTxHash, {
      ...decisionContext(
        "The $65,000 rung pays first if BTC falls this week, and costs the least per dollar covered.",
      ),
      signalReceiptIds: [DEMO_RECEIPT],
    });
  }
  await recordSignalPayment(baseURL, DEMO_RECEIPT, new Date().toISOString(), AGENT_ADDRESS);
  await reportSignalBudget(baseURL, AGENT_ADDRESS);
  // The holding the plan below is sized for, so the hedge page agrees with itself.
  await saveHoldingsAsOwner(baseURL, [{ asset: "BTC", quantity: "0.05", note: "Cold wallet" }]);
  const committed = ready.chain?.committedCents ?? 0;
  await agentApi(
    baseURL,
    CONSOLE_AGENT_ROUTES.plans,
    "POST",
    await recordedPlanRequest({
      quantity: "0.05",
      dropPercent: 5,
      maxCostCents: 6_000,
      maxTradeCents: DEMO_POLICY.maxTradeCents,
      remainingBudgetCents: DEMO_POLICY.budgetCents - committed,
      requestText: "Protect my 0.05 BTC against a 5% drop this week, for at most $60.",
    }),
  );
  for (const route of routes) {
    const response = await fetch(new URL(route.path, baseURL));
    await response.arrayBuffer();
  }
}
