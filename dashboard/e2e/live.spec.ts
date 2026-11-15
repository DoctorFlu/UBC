import { type ChildProcess, spawn } from "node:child_process";

import { type Page, expect, test } from "@playwright/test";

import type { ConsoleSnapshot } from "../src/lib/live/types";
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
import { E2E_SERVICE_TOKEN, decisionContext, sealReason, snapshot, waitForSnapshot } from "./support/console";

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
const baseURL = `http://localhost:${PORT.toString()}`;

test.describe.configure({ mode: "serial" });
test.use({ baseURL, viewport: { width: 1440, height: 900 } });

let chain: TestChain;
let server: ChildProcess | null = null;
const paths = suitePaths("live");

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
    },
  });
  await waitForSnapshot(baseURL, (current) => current.feed.health === "live", 180_000);
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

function toast(page: Page) {
  return page.getByRole("region", { name: "Notifications" });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  freshSuiteDir("live");
  chain = await startTestChain({ port: CHAIN_PORT, deploymentFile: paths.deploymentFile });
  await startConsole();
});

test.afterAll(async () => {
  await stopConsole();
  await chain.anvil.stop();
});

test("before the first mandate, the console says so", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main").getByText("No mandate yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Set the mandate" })).toBeVisible();
  await page.goto("/activity");
  await expect(page.getByText("No intents yet").first()).toBeVisible();
});

test("the owner signs the first mandate", async ({ page }) => {
  await page.goto("/mandate");
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
  await page.goto("/activity");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  const proposed = await chain.agent.proposeTrade(noBuy(BTC_65K, 1_000, 31));
  expect(proposed).toMatchObject({ intentId: 0, verdict: "approved" });
  const seenBy = Date.now() + 2_000;
  await expect(row(page, 0)).toBeVisible({ timeout: 2_000 });
  expect(Date.now()).toBeLessThanOrEqual(seenBy);
  await expect(row(page, 0)).toContainText("Approved");
});

test("the owner approves one held intent and rejects another", async ({ page }) => {
  await page.goto("/activity");
  await chain.agent.proposeTrade(noBuy(BTC_65K, 2_200, 31));
  await chain.agent.proposeTrade(noBuy(BTC_64K, 2_400, 24));
  await expect(row(page, 1)).toContainText("Waiting");
  await expect(row(page, 2)).toContainText("Waiting");

  // Approve by pressing twice: the alternative to holding, for keyboards and screen readers.
  const approve = row(page, 1).getByRole("button", { name: /^Approve \$22\.00/ });
  await approve.click();
  await approve.click();
  await expect(toast(page)).toContainText("Approved");
  await expect(row(page, 1)).toContainText("Approved");

  await row(page, 2)
    .getByRole("button", { name: /^Reject \$24\.00/ })
    .click();
  await expect(row(page, 2)).toContainText("rejected by user");
});

test("a fill the executor records appears on the intent", async ({ page }) => {
  await page.goto("/activity/1");
  await expect(page.getByRole("heading", { level: 1, name: "Intent #1" })).toBeVisible();
  await chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 2_200, pnlCents: 0 });
  await expect(page.locator("main").getByText("Executed").first()).toBeVisible();
});

test("a rule that blocks an intent says so on the overview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Nothing blocked today").first()).toBeVisible();
  const blocked = await chain.agent.proposeTrade(noBuy(BTC_65K, 3_000, 31));
  expect(blocked).toMatchObject({ intentId: 3, verdict: "rejected", reason: "over max trade size" });
  await expect(page.getByText("Blocked 1 today")).toBeVisible();
});

test("the kill switch pauses the agent and the contract refuses its next proposal", async ({ page }) => {
  await page.goto("/");
  const isolator = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await isolator.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("paused-banner")).toBeVisible();
  await expect(toast(page)).toContainText("Agent paused");

  const refused = await chain.agent.proposeTrade(noBuy(BTC_65K, 500, 31));
  expect(refused).toMatchObject({ intentId: 4, verdict: "rejected", reason: "agent paused" });
  await page.goto("/activity");
  await expect(row(page, 4)).toContainText("agent paused");
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
  await page.goto("/activity/0");
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

  await page.goto("/activity");
  for (const id of [0, 1, 2, 3, 4]) await expect(row(page, id)).toBeVisible();
  await expect(page.getByTestId("paused-banner")).toBeVisible();
});
