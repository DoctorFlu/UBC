import { readFile } from "node:fs/promises";

import { type FullConfig, chromium } from "@playwright/test";

import { DEMO_POLICY, devPolicyClient } from "@mandate/devchain";
import { CONSOLE_AGENT_ROUTES } from "@mandate/shared";
import type { Address } from "viem";

import { AGENT_ADDRESS, routePath, routes } from "./routes";
import { suitePaths } from "./support/chain";
import {
  DEMO_RECEIPT,
  agentApi,
  announceAgent,
  carryOutPlan,
  decisionContext,
  recordSignalPayment,
  reportSignalBudget,
  saveHoldingsAsOwner,
  sealReason,
  waitForSnapshot,
} from "./support/console";
import { recordedPlanRequest, recordedSignal } from "./support/fake-gemini";
import { claimOwner, forgetOwner, ownerStatePath } from "./support/session";

/** Intents the demo seed proposes (support/chain.ts `seedDemo`). */
const DEMO_INTENTS = 7;

/**
 * Runs once the demo chain and the console are up (the live suite starts its own and skips this):
 * 0. Claims the first workspace on /claim with a virtual passkey, and saves the owner's session.
 * 1. Waits until the console has read the whole demo history from the chain.
 * 2. Saves the owner's 0.05 BTC holding (signed with the dev owner key) and plays the agent's MCP server
 *    once: announces the agent, seals the reason for intent 0, reports one signal payment (cited by
 *    intent 0's reason) and its signal budget, and posts a hedge plan made by the real planner with that
 *    signal on the recorded Gemini ladder the fake Gemini serves. Then it carries out the plan's first
 *    two orders on the chain (intents 7 and 8, sealed with the plan and the receipt), and the executor
 *    fills the first: the plan's evidence chain is complete and verified.
 * 3. `next dev` compiles each route on its first request, and each browser chunk on the first page
 *    that loads it. Tests that hit a cold route in parallel can wait long enough for Chrome to log
 *    "preloaded but not used" warnings, which the smoke test rightly treats as failures, or for a busy
 *    machine to run out the test's time. Opening every route once in a real browser, in order, before
 *    the tests compiles both; so does opening the account pages signed out and calling the account API.
 */
export default async function warmUp(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL || process.env.E2E_SUITE === "live") return;
  // The owner claims the first workspace on the claim page, with a code from the admin command; every
  // test then opens the console with that session (playwright.config.ts `storageState`).
  forgetOwner(baseURL);
  const suite = suitePaths(process.env.E2E_SERVER === "prod" ? "screenshots" : "smoke");
  const claimer = await chromium.launch();
  try {
    await claimOwner(claimer, baseURL, suite.dataDir);
  } finally {
    await claimer.close();
  }
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
  const requestText = "Protect my 0.05 BTC against a 5% drop this week, for at most $60.";
  const request = await recordedPlanRequest({
    quantity: "0.05",
    dropPercent: 5,
    maxCostCents: 6_000,
    maxTradeCents: DEMO_POLICY.maxTradeCents,
    remainingBudgetCents: DEMO_POLICY.budgetCents - committed,
    requestText,
    signal: await recordedSignal(DEMO_RECEIPT),
  });
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.plans, "POST", request);

  // The agent carries out the plan's first two orders, citing it and the signal; one fills.
  const deployment = JSON.parse(await readFile(suite.deploymentFile, "utf8")) as {
    rpcUrl: string;
    address: Address;
  };
  const agent = devPolicyClient(deployment.rpcUrl, deployment.address, "agent");
  const executor = devPolicyClient(deployment.rpcUrl, deployment.address, "executor");
  const [filled] = await carryOutPlan(baseURL, agent, request.plan, {
    requestText,
    receiptIds: [DEMO_RECEIPT],
    orders: [0, 1],
  });
  if (filled) {
    await executor.recordResult({
      intentId: filled.intentId,
      filled: true,
      filledCents: request.plan.orders[0]?.amountCents ?? 0,
      pnlCents: 0,
    });
  }
  await waitForSnapshot(
    baseURL,
    (snapshot) =>
      (snapshot.chain?.intents.length ?? 0) >= DEMO_INTENTS + 2 &&
      snapshot.chain?.sealed[DEMO_INTENTS + 1]?.status === "verified" &&
      snapshot.chain.intents[DEMO_INTENTS]?.status === "executed",
    60_000,
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL, storageState: ownerStatePath(baseURL) });
    for (const route of routes) {
      await page.goto(await routePath(route, baseURL), { waitUntil: "load", timeout: 180_000 });
      // Hydrated means every chunk of the page has loaded; the requests the page then makes (the hedge
      // page's quotes) compile their API routes before networkidle.
      if (route.console) {
        await page.locator("html[data-page-hydrated]").waitFor({ state: "attached", timeout: 180_000 });
      }
      await page.waitForLoadState("networkidle", { timeout: 180_000 });
    }
    // The account pages, signed out, and the account API routes a test calls later: any answer, even a
    // refusal, means the route is compiled.
    const signedOut = await browser.newPage({ baseURL });
    for (const path of ACCOUNT_PAGES) {
      await signedOut.goto(path, { waitUntil: "load", timeout: 180_000 });
      await signedOut.locator("html[data-page-hydrated]").waitFor({ state: "attached", timeout: 180_000 });
    }
    for (const path of ACCOUNT_API_ROUTES) {
      const response = await fetch(new URL(path, baseURL), {
        method: path.endsWith("/session") || path === "/api/console/agents" ? "GET" : "POST",
        signal: AbortSignal.timeout(180_000),
      });
      await response.arrayBuffer();
    }
  } finally {
    await browser.close();
  }
}

const ACCOUNT_PAGES = ["/sign-in", "/sign-up", "/recover"];

const ACCOUNT_API_ROUTES = [
  "/api/auth/session",
  "/api/auth/sign-up",
  "/api/auth/register",
  "/api/auth/sign-in",
  "/api/auth/sign-in/verify",
  "/api/auth/sign-out",
  "/api/auth/recover",
  "/api/console/agents",
  "/api/console/agents/agt_warm_up/tokens",
  "/api/console/agents/agt_warm_up/tokens/tok_warm_up",
  "/api/console/passkeys",
];
