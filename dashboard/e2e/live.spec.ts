import { type ChildProcess, spawn } from "node:child_process";

import { type Page, expect, test } from "@playwright/test";

import { CONSOLE_AGENT_ROUTES } from "@mandate/shared";

import { formatContractsHundredths, formatUsdCents } from "../src/lib/format";
import type { ConsoleSnapshot } from "../src/lib/live/types";
import { AGENT_ADDRESS, routes } from "./routes";
import {
  BTC_64K,
  BTC_65K,
  DASHBOARD_DIR,
  type TestChain,
  freshSuiteDir,
  noBuy,
  startTestChain,
  suitePaths,
} from "./support/chain";
import {
  E2E_SERVICE_TOKEN,
  agentApi,
  decisionContext,
  sealReason,
  snapshot,
  waitForSnapshot,
} from "./support/console";
import { type FakeGemini, recordedPlanRequest, startFakeGemini } from "./support/fake-gemini";

/**
 * The owner's whole loop against a real chain, as a person would do it: set the first mandate, watch
 * intents arrive without a refresh, approve one, reject one, see a fill, pull the kill switch and watch
 * the contract refuse the next proposal, then restart the console and find exactly the same state.
 *
 * It owns its processes: a fresh anvil with the production Policy contract, and `next dev` on its own
 * port and data directory, which it stops and starts again for the restart.
 */

const PORT = Number(process.env.E2E_LIVE_PORT ?? 3102);
const CHAIN_PORT = Number(process.env.E2E_LIVE_CHAIN_PORT ?? 8646);
const GEMINI_PORT = Number(process.env.E2E_LIVE_GEMINI_PORT ?? 8656);
const baseURL = `http://localhost:${PORT.toString()}`;

test.describe.configure({ mode: "serial" });
test.use({ baseURL, viewport: { width: 1440, height: 900 } });

let chain: TestChain;
let gemini: FakeGemini;
let server: ChildProcess | null = null;
const paths = suitePaths("live");
/** Every page the dashboard serves; `/activity/0` compiles the detail route even before intent 0 exists. */
const LIVE_ROUTES = routes.map((route) => route.path);

async function startConsole(): Promise<void> {
  server = spawn("npx", ["next", "dev", "--port", PORT.toString()], {
    cwd: DASHBOARD_DIR,
    // Its own process group, so stopping it stops next's workers too.
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      NEXT_PUBLIC_DEV_SIGNER: "1",
      POLICY_ADDRESS: "",
      POLICY_DEPLOY_BLOCK: "",
      POLICY_DEPLOYMENT_FILE: paths.deploymentFile,
      CONSOLE_DATA_DIR: paths.dataDir,
      CONSOLE_EVENT_SOURCE: "rpc",
      CONSOLE_SERVICE_TOKEN: E2E_SERVICE_TOKEN,
      CONSOLE_URL: baseURL,
      GEMINI_API_URL: gemini.url,
    },
  });
  await waitForSnapshot(baseURL, (current) => current.feed.health === "live", 180_000);
  // `next dev` compiles a route on its first request and then tells open pages to reload. With a
  // Turbopack cache left by an earlier run (the smoke suite compiles every route), a page that connects
  // before those routes are compiled again reloads over and over. Compiling every route first, as the
  // smoke warm-up does, removes that.
  for (const path of LIVE_ROUTES) {
    const response = await fetch(new URL(path, baseURL));
    await response.arrayBuffer();
  }
}

async function stopConsole(): Promise<void> {
  const running = server;
  server = null;
  if (!running?.pid) return;
  const exited = new Promise((resolve) => running.once("exit", resolve));
  process.kill(-running.pid, "SIGTERM");
  await exited;
}

/** What must survive a restart: everything read from the chain and the console's own store. */
function durableState(current: ConsoleSnapshot) {
  return { contract: current.contract, chain: current.chain, offchain: current.offchain };
}

function row(page: Page, intentId: number) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: `Intent #${intentId.toString()}`, exact: true }) })
    .filter({ visible: true });
}

/**
 * Opens a page and waits until the dev signer is connected, which happens only after React hydrates:
 * an owner action pressed earlier would hit server HTML that does nothing yet.
 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("owner-address").filter({ visible: true })).toBeVisible();
}

function toast(page: Page) {
  return page.getByRole("region", { name: "Notifications" });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  freshSuiteDir("live");
  gemini = await startFakeGemini(GEMINI_PORT);
  chain = await startTestChain({ port: CHAIN_PORT, deploymentFile: paths.deploymentFile });
  await startConsole();
});

test.afterAll(async () => {
  await stopConsole();
  await chain.anvil.stop();
  await gemini.stop();
});

test("before the first mandate, the console says so", async ({ page }) => {
  await open(page, "/");
  await expect(page.locator("main").getByText("No mandate yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Set the mandate" })).toBeVisible();
  await open(page, "/activity");
  await expect(page.getByText("No intents yet").first()).toBeVisible();
});

test("the owner signs the first mandate", async ({ page }) => {
  await open(page, "/mandate");
  await expect(page.getByRole("heading", { name: "Set the first mandate" })).toBeVisible();
  await page.getByRole("button", { name: "Review and sign" }).click();
  const review = page.getByRole("dialog", { name: "Review the first mandate" });
  await expect(review.getByTestId("policy-review")).toContainText("Budget");
  await review.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(toast(page)).toContainText("Mandate set");
  await review.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/^Version 1, set /)).toBeVisible();
  const rules = (await snapshot(baseURL)).chain?.rules;
  expect(rules).toMatchObject({ budgetCents: 20_000, maxTradeCents: 2_500, approvalAboveCents: 2_000 });
});

test("a proposal shows up within 2 seconds, without a refresh", async ({ page }) => {
  await open(page, "/activity");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  const proposed = await chain.agent.proposeTrade(noBuy(BTC_65K, 1_000, 31));
  expect(proposed).toMatchObject({ intentId: 0, verdict: "approved" });
  const seenBy = Date.now() + 2_000;
  await expect(row(page, 0)).toBeVisible({ timeout: 2_000 });
  expect(Date.now()).toBeLessThanOrEqual(seenBy);
  await expect(row(page, 0)).toContainText("Approved");
});

test("the owner approves one held intent and rejects another", async ({ page }) => {
  await open(page, "/activity");
  await chain.agent.proposeTrade(noBuy(BTC_65K, 2_200, 31));
  await chain.agent.proposeTrade(noBuy(BTC_64K, 2_400, 24));
  await expect(row(page, 1)).toContainText("Waiting");
  await expect(row(page, 2)).toContainText("Waiting");

  // Approve by pressing twice: the alternative to holding, for keyboards and screen readers. The
  // first press arms the button without moving it, says what the second press does, and the second
  // press still counts well after the 5 seconds the old window allowed.
  const approve = row(page, 1).getByRole("button", { name: /^Approve \$22\.00/ });
  const before = await approve.boundingBox();
  await approve.click();
  await expect(approve).toHaveAttribute("data-phase", "armed");
  await expect(approve.getByText("Confirm approval", { exact: true })).toBeVisible();
  expect(await approve.boundingBox()).toEqual(before);
  await page.waitForTimeout(6_500);
  await expect(approve).toHaveAttribute("data-phase", "armed");
  await approve.click();
  await expect(toast(page)).toContainText("Approved");
  await expect(row(page, 1)).toContainText("Approved");

  // Rejecting is a signed transaction too, so it takes the same two steps.
  const reject = row(page, 2).getByRole("button", { name: /^Reject \$24\.00/ });
  await reject.click();
  await expect(reject.getByText("Confirm rejection", { exact: true })).toBeVisible();
  await expect(row(page, 2)).toContainText("Waiting");
  await reject.click();
  await expect(row(page, 2)).toContainText("rejected by user");
});

test("a fill the executor records appears on the intent", async ({ page }) => {
  await open(page, "/activity/1");
  await expect(page.getByRole("heading", { level: 1, name: "Intent #1" })).toBeVisible();
  await chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 2_200, pnlCents: 0 });
  await expect(page.locator("main").getByText("Executed").first()).toBeVisible();
  // The contract only knows the executor recorded a fill, and on the devchain that executor is a
  // simulator: say exactly that, never where the order went.
  const timeline = page.getByTestId("intent-timeline");
  await expect(timeline).toContainText("The executor recorded a fill of $22.00.");
  await expect(timeline.getByTestId("simulated-fill")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Gemini");

  await open(page, "/activity");
  await expect(page.getByTestId("simulated-fill")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("on Gemini");
});

test("a rule that blocks an intent says so on the overview", async ({ page }) => {
  await open(page, "/");
  await expect(page.getByText("Nothing blocked today").first()).toBeVisible();
  const blocked = await chain.agent.proposeTrade(noBuy(BTC_65K, 3_000, 31));
  expect(blocked).toMatchObject({ intentId: 3, verdict: "rejected", reason: "over max trade size" });
  await expect(page.getByText("Blocked 1 today")).toBeVisible();
});

test("editing a limit changes the backtest of past intents before anything is signed", async ({ page }) => {
  const before = await snapshot(baseURL);
  await open(page, "/mandate");
  const backtest = page.getByTestId("backtest");
  // The draft starts as the rules in force, which gave every one of the four intents its verdict.
  await expect(backtest).toHaveAttribute("data-changed", "0");
  await expect(backtest).toContainText("No verdict changes: all 4 past intents get the same answer");

  // A lower max trade size (with the approval threshold under it, as the form requires): the $22 and
  // $24 intents, held in reality, would be rejected outright.
  const maxTrade = page.getByRole("textbox", { name: "Max trade size" });
  const approvalAbove = page.getByRole("textbox", { name: "Approval above" });
  await approvalAbove.fill("10");
  await expect(backtest).toHaveAttribute("data-changed", "0");
  await maxTrade.fill("15");
  await expect(backtest).toHaveAttribute("data-changed", "2");
  await expect(backtest).toContainText("2 of 4 past intents would get a different answer");
  const changed = backtest.getByRole("region", { name: /verdict changes under the draft/ });
  await expect(changed.locator("tbody tr")).toHaveCount(2);
  await expect(changed.locator("tbody tr").first()).toContainText("#1");
  await expect(changed.locator("tbody tr").first()).toContainText("over max trade size");

  // Never asking for approval instead: the same two intents would have been approved.
  await maxTrade.fill("25");
  await approvalAbove.fill("0");
  await expect(backtest).toHaveAttribute("data-changed", "2");
  await expect(changed.locator("tbody tr").first()).toContainText("Approved");

  // A value that does not parse stops the replay and says why, without moving anything.
  await maxTrade.fill("abc");
  await expect(backtest).toHaveAttribute("data-state", "invalid");

  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByTestId("backtest")).toHaveAttribute("data-changed", "0");
  // Nothing was signed: the contract's rules are the ones from before.
  expect((await snapshot(baseURL)).chain?.rules).toEqual(before.chain?.rules);
});

test("the agent's change request shows a diff and its backtest, and applying it lands onchain", async ({
  page,
}) => {
  const filed = (await agentApi(baseURL, CONSOLE_AGENT_ROUTES.policyChangeRequests, "POST", {
    agentAddress: AGENT_ADDRESS,
    proposed: { maxTradeCents: 3_500 },
    reason: "The $64,000 rung needs a $30 order; splitting it costs more than it saves.",
  })) as { id: string; status: string };
  expect(filed.status).toBe("pending");

  await open(page, "/mandate");
  // A pending request opens its tab and counts on it.
  await expect(page.getByRole("tab", { name: /Change requests/ })).toHaveAttribute("aria-selected", "true");
  const card = page.locator(`[data-testid="change-request"][data-status="pending"]`);
  await expect(card).toContainText("asks to change max trade size");
  await expect(card).toContainText("splitting it costs more than it saves");
  const diff = card.getByTestId("request-diff");
  await expect(diff.locator("tbody tr")).toHaveCount(1);
  await expect(diff).toContainText("$25.00");
  await expect(diff).toContainText("$35.00");
  // Under a $35 max trade size, the $30 intent the contract rejected would have waited for the owner.
  const backtest = card.getByTestId("backtest");
  await expect(backtest).toHaveAttribute("data-changed", "1");
  await expect(backtest).toContainText("under the requested rules");

  await card.getByRole("button", { name: "Review and sign" }).click();
  const review = page.getByRole("dialog", { name: "Apply the agent's request" });
  await expect(review.getByTestId("policy-review")).toContainText("Max trade size");
  await review.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(toast(page)).toContainText("Mandate updated");
  await review.getByRole("button", { name: "Done" }).click();

  // The request is closed with the transaction that applied it, and the contract has the new rule.
  const applied = page.locator(`[data-testid="change-request"][data-status="applied"]`);
  await expect(applied).toContainText("asked to change max trade size");
  await expect(applied).toContainText("Applied");
  const after = await waitForSnapshot(
    baseURL,
    (current) =>
      current.offchain.changeRequests.find((request) => request.id === filed.id)?.status === "applied",
  );
  expect(after.chain?.rules?.maxTradeCents).toBe(3_500);
  const request = after.offchain.changeRequests.find((candidate) => candidate.id === filed.id);
  expect(request?.appliedTxHash).toBe(after.chain?.policySetBy?.txHash);
  expect(await chain.user.getRules()).toMatchObject({ maxTradeCents: 3_500 });
  // The agent sees it closed too.
  const seen = (await agentApi(baseURL, CONSOLE_AGENT_ROUTES.policyChangeRequest(filed.id), "GET")) as {
    status: string;
    appliedTxHash: string;
  };
  expect(seen).toMatchObject({ status: "applied", appliedTxHash: request?.appliedTxHash });
  await expect(page.getByRole("tab", { name: /Change requests/ })).toContainText("0");
});

test("the owner can dismiss a change request, and the rules stay as they are", async ({ page }) => {
  const filed = (await agentApi(baseURL, CONSOLE_AGENT_ROUTES.policyChangeRequests, "POST", {
    agentAddress: AGENT_ADDRESS,
    proposed: { budgetCents: 50_000 },
    reason: "More room for next week's ladder.",
  })) as { id: string };
  const rules = (await snapshot(baseURL)).chain?.rules;
  await open(page, "/mandate");
  const card = page.locator(`[data-testid="change-request"][data-status="pending"]`);
  await expect(card).toContainText("asks to change budget");
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toContainText("Request dismissed");
  await expect(page.locator(`[data-testid="change-request"][data-status="dismissed"]`)).toContainText(
    "Dismissed",
  );
  const seen = (await agentApi(baseURL, CONSOLE_AGENT_ROUTES.policyChangeRequest(filed.id), "GET")) as {
    status: string;
  };
  expect(seen.status).toBe("dismissed");
  expect((await snapshot(baseURL)).chain?.rules).toEqual(rules);
});

test("the hedge view: an honest empty state and preview, then the agent's plan, executed onchain", async ({
  page,
}) => {
  await open(page, "/hedge");
  await expect(page.getByText(/has not planned a hedge for BTC/)).toBeVisible();
  await expect(page.getByTestId("hedge-preview")).toHaveText(
    "No preview: Save your BTC holding to see a preview.",
  );
  await expect(page.getByTestId("live-ladder")).toBeVisible();

  // Save a holding through the UI: the preview follows at once, made by the same planner.
  const save = page.getByRole("button", { name: "Sign and save" });
  await page.getByRole("button", { name: "Add an asset" }).click();
  const holding = page.getByTestId("holding-row").last();
  await holding.getByRole("textbox", { name: "Asset" }).fill("BTC");
  await holding.getByRole("textbox", { name: "Quantity" }).fill("0.05");
  await save.click();
  await expect(toast(page)).toContainText("Holdings saved");
  const state = await snapshot(baseURL);
  const rules = state.chain?.rules;
  if (!rules) throw new Error("no mandate");
  const remaining = rules.budgetCents - (state.chain?.committedCents ?? 0);
  const expected = (
    await recordedPlanRequest({
      quantity: "0.05",
      dropPercent: 10,
      maxCostCents: remaining,
      maxTradeCents: rules.maxTradeCents,
      remainingBudgetCents: remaining,
      requestText: "",
    })
  ).plan;
  const preview = page.getByTestId("hedge-preview");
  await expect(preview).toContainText("Preview, not the agent’s plan.");
  await expect(preview).toContainText(formatUsdCents(expected.totals.costCents));
  await expect(preview).toContainText(formatContractsHundredths(expected.totals.contractsHundredths));
  await expect(page.getByTestId("agent-plan")).toHaveCount(0);

  // The agent posts its plan: it replaces the preview without a refresh.
  const request = await recordedPlanRequest({
    quantity: "0.05",
    dropPercent: 5,
    maxCostCents: 6_000,
    maxTradeCents: rules.maxTradeCents,
    remainingBudgetCents: remaining,
    requestText: "Protect my 0.05 BTC against a 5% drop this week.",
  });
  const { plan } = request;
  const order = [...plan.orders].sort((a, b) => a.amountCents - b.amountCents)[0];
  if (!order) throw new Error("the plan has no orders");
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.plans, "POST", request);
  const card = page.getByTestId("agent-plan");
  await expect(card).toHaveAttribute("data-plan-id", plan.planId);
  await expect(card).toContainText(request.requestText);
  await expect(page.getByTestId("hedge-preview")).toHaveCount(0);
  await expect(page.getByTestId("plan-execution")).toHaveText(
    "Not executed: no intent on the chain cites this plan yet.",
  );

  // The agent proposes one of the plan's orders and seals a reason naming the plan; the executor fills it.
  const proposed = await chain.agent.proposeTrade(
    noBuy(order.instrumentSymbol, order.amountCents, order.limitPriceCents),
  );
  if (proposed.verdict === "needs_approval") await chain.user.approveIntent(proposed.intentId);
  const intent = (
    await waitForSnapshot(baseURL, (current) =>
      Boolean(current.chain?.intents.some((candidate) => candidate.id === proposed.intentId)),
    )
  ).chain?.intents.find((candidate) => candidate.id === proposed.intentId);
  if (!intent) throw new Error("the proposal did not reach the console");
  await sealReason(baseURL, intent.id, intent.proposedTxHash, {
    ...decisionContext("The cheapest rung of the plan, bought first."),
    planId: plan.planId,
  });
  await chain.executor.recordResult({
    intentId: intent.id,
    filled: true,
    filledCents: order.amountCents,
    pnlCents: 0,
  });
  await expect(page.getByTestId("plan-execution")).toHaveText(
    `1 of ${plan.orders.length.toString()} orders proposed, 1 filled.`,
  );
  const onChain = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: `Intent #${intent.id.toString()}`, exact: true }) });
  await expect(onChain).toContainText(formatContractsHundredths(order.quantityHundredths));
  await expect(onChain).toContainText("Executed");

  // Gemini goes down: the quotes say so, and the plan stays.
  gemini.setFailing(true);
  try {
    await expect(page.getByTestId("quotes-error")).toContainText("did not answer", { timeout: 45_000 });
    await expect(card).toBeVisible();
    await expect(page.getByTestId("live-ladder")).toHaveCount(0);
  } finally {
    gemini.setFailing(false);
  }
});

test("the kill switch pauses the agent and the contract refuses its next proposal", async ({ page }) => {
  await open(page, "/");
  const isolator = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await isolator.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("paused-banner")).toBeVisible();
  await expect(toast(page)).toContainText("Agent paused");

  const refused = await chain.agent.proposeTrade(noBuy(BTC_65K, 500, 31));
  expect(refused).toMatchObject({ verdict: "rejected", reason: "agent paused" });
  await open(page, "/activity");
  await expect(row(page, refused.intentId)).toContainText("agent paused");
});

test("the agent's reason, linked offchain, is checked against the intent", async ({ page }) => {
  const first = (await snapshot(baseURL)).chain?.intents[0];
  expect(first).toBeDefined();
  if (!first) return;
  await sealReason(
    baseURL,
    0,
    first.proposedTxHash,
    decisionContext("Cheapest protection for the first $1,000 drop."),
  );
  await open(page, "/activity/0");
  const sealed = page.getByTestId("sealed-reason");
  await expect(page.getByText("Recorded offchain", { exact: true })).toBeVisible();
  await expect(sealed).toContainText("Verified");
  await expect(sealed).toContainText("Cheapest protection");
});

test("a restarted console rebuilds exactly the same state", async ({ page }) => {
  const before = await snapshot(baseURL);
  await stopConsole();
  await startConsole();
  const after = await waitForSnapshot(
    baseURL,
    (current) => (current.feed.syncedBlock ?? -1) >= (before.feed.syncedBlock ?? 0),
  );
  expect(durableState(after)).toEqual(durableState(before));

  await open(page, "/activity");
  for (const intent of after.chain?.intents ?? []) await expect(row(page, intent.id)).toBeVisible();
  await expect(page.getByTestId("paused-banner")).toBeVisible();
});
