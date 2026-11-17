import { type ChildProcess, spawn } from "node:child_process";

import { type Page, expect, test } from "@playwright/test";

import { DEMO_POLICY } from "@mandate/devchain";
import { CONSOLE_AGENT_ROUTES, WAKE_DEBOUNCE_MS, type WakeEvent, wakeEventSchema } from "@mandate/shared";
import { createTestClient, http } from "viem";

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
  ownerHeaders,
  snapshot,
  waitForConsole,
  waitForSnapshot,
  firstMandatePath,
} from "./support/console";
import { claimOwnerOnce, forgetOwner, signInAsOwner } from "./support/session";
import { type FakeGemini, recordedPlanRequest, startFakeGemini } from "./support/fake-gemini";
import { type FakeWebhook, startFakeWebhook } from "./support/fake-webhook";

/**
 * Event wake-ups (issue #40) the way production runs them: the real console (`next dev`) reading a real
 * chain, the fake Gemini the suites share, and a local stand-in for the routine's webhook. Real triggers
 * (a rejected intent, a late fill, the owner's kill switch in the browser, a fall of spot) must each send
 * exactly one well-formed event; the debounce and the daily cap must hold; a restart must resend nothing;
 * and neither the webhook's secret path nor its key may reach the console's output or its pages.
 *
 * The wake-ups run on the console's test clock (`GROK_WAKE_TEST_CLOCK=on`, issue #110), which the spec
 * moves past a debounce window itself: a slow or sleeping machine can never end one between two tests.
 */

const PORT = Number(process.env.E2E_WAKE_PORT ?? 3104);
const CHAIN_PORT = Number(process.env.E2E_WAKE_CHAIN_PORT ?? 8648);
const GEMINI_PORT = Number(process.env.E2E_WAKE_GEMINI_PORT ?? 8658);
const WEBHOOK_PORT = Number(process.env.E2E_WAKE_WEBHOOK_PORT ?? 8668);
const baseURL = `http://localhost:${PORT.toString()}`;
/** Low, so the suite reaches it: five wake-ups are sent, the sixth must not be. */
const DAILY_CAP = 5;

test.describe.configure({ mode: "serial" });
test.use({ baseURL, viewport: { width: 1440, height: 900 } });

let chain: TestChain;
let gemini: FakeGemini;
let webhook: FakeWebhook;
let server: ChildProcess | null = null;
let output = "";
const paths = suitePaths("wake");

async function startConsole(): Promise<void> {
  server = spawn("npx", ["next", "dev", "--port", PORT.toString()], {
    cwd: DASHBOARD_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
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
      GROK_WEBHOOK_URL: webhook.url,
      GROK_WEBHOOK_KEY: webhook.key,
      GROK_WAKE_DAILY_CAP: DAILY_CAP.toString(),
      GROK_WAKE_PRICE_CHECK_MS: "1000",
      GROK_WAKE_TEST_CLOCK: "on",
      NEXT_DEV_CACHE: "off",
    },
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      output += chunk;
    });
  }
  await waitForConsole(baseURL);
  // The first start claims the first workspace on /claim, as its owner would; a restart keeps the session.
  await claimOwnerOnce(baseURL, paths.dataDir);
  await waitForSnapshot(baseURL, (current) => current.feed.health === "live", 180_000);
  for (const path of ["/", "/setup", "/activity"]) {
    const response = await fetch(new URL(path, baseURL), { headers: ownerHeaders(baseURL) });
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

/** The well-formed events the webhook accepted, in order. */
function events(): WakeEvent[] {
  return webhook.received.map((request) => {
    expect(request.authorization).toBe(`Bearer ${webhook.key}`);
    expect(request.contentType).toBe("application/json");
    return wakeEventSchema.parse(request.body);
  });
}

async function received(count: number, timeoutMs = 20_000): Promise<WakeEvent[]> {
  await expect.poll(() => webhook.received.length, { timeout: timeoutMs }).toBeGreaterThanOrEqual(count);
  return events();
}

/** Moves the wake-ups' clock forward; the console answers once what is due by then has been sent. */
async function advanceWakeClock(ms: number): Promise<void> {
  const response = await fetch(new URL("/api/dev/wake-clock", baseURL), {
    method: "POST",
    headers: { authorization: `Bearer ${E2E_SERVICE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ advanceMs: ms }),
  });
  expect(response.status).toBe(200);
}

/** Lets the console read the chain's head and act on it, then returns what it shows. */
async function settled() {
  const head = Number(await chain.user.publicClient.getBlockNumber({ cacheTime: 0 }));
  await waitForSnapshot(baseURL, (current) => (current.feed.syncedBlock ?? -1) >= head);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return snapshot(baseURL);
}

async function open(page: Page, path: string): Promise<void> {
  // `/` is the workspace Home (#95); the owner acts on the first mandate's Overview.
  await page.goto(path === "/" ? await firstMandatePath(baseURL) : path);
  await expect(page.getByTestId("owner-address").filter({ visible: true })).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  freshSuiteDir("wake");
  forgetOwner(baseURL);
  gemini = await startFakeGemini(GEMINI_PORT);
  webhook = await startFakeWebhook(WEBHOOK_PORT);
  chain = await startTestChain({ port: CHAIN_PORT, deploymentFile: paths.deploymentFile });
  // Before the console first reads the chain: history, which must wake nothing.
  await chain.user.setPolicy(DEMO_POLICY);
  await startConsole();
});

// The owner's session, which `beforeAll` made when it claimed the console.
test.beforeEach(async ({ context }) => {
  await signInAsOwner(context, baseURL);
});

test.afterAll(async () => {
  await stopConsole();
  await chain.anvil.stop();
  await gemini.stop();
  await webhook.stop();
});

test("the chain's history wakes nothing, and wake-ups are on", async () => {
  const current = await settled();
  expect(webhook.received).toEqual([]);
  expect(current.wake).toMatchObject({
    enabled: true,
    dailyCap: DAILY_CAP,
    leftToday: DAILY_CAP,
    recent: [],
  });
});

test("an intent the contract rejects sends one event; a second one waits for the debounce window to end", async () => {
  const rejected = await chain.agent.proposeTrade(noBuy(BTC_65K, 3_000, 31));
  expect(rejected.verdict).toBe("rejected");
  const [event] = await received(1);
  expect(event).toMatchObject({
    type: "mandate.wake",
    version: 1,
    kind: "intent_rejected",
    count: 1,
    attempt: 1,
    summary: `The contract rejected intent #${rejected.intentId.toString()}: over max trade size.`,
    link: `${baseURL}/activity/${rejected.intentId.toString()}`,
  });

  const again = await chain.agent.proposeTrade(noBuy(BTC_64K, 3_000, 24));
  expect(again.verdict).toBe("rejected");
  const current = await settled();
  expect(webhook.received).toHaveLength(1);
  expect(current.wake.recent[0]).toMatchObject({ kind: "intent_rejected", status: "queued", count: 1 });

  // A minute before the window ends it still waits; at its end it goes out, once.
  await advanceWakeClock(WAKE_DEBOUNCE_MS.intent_rejected - 60_000);
  expect(webhook.received).toHaveLength(1);
  await advanceWakeClock(60_000);
  const [, second] = await received(2);
  expect(second).toMatchObject({
    kind: "intent_rejected",
    count: 1,
    summary: `The contract rejected intent #${again.intentId.toString()}: over max trade size.`,
  });
  expect((await snapshot(baseURL)).wake.recent[0]).toMatchObject({ kind: "intent_rejected", status: "sent" });
});

test("a fill recorded long after its approval sends one event; one right after it sends none", async () => {
  const quick = await chain.agent.proposeTrade(noBuy(BTC_65K, 500, 31));
  await chain.executor.recordResult({
    intentId: quick.intentId,
    filled: true,
    filledCents: 500,
    pnlCents: 0,
  });
  // An order the owner approves at the end of the suite, over the cap.
  const held = await chain.agent.proposeTrade(noBuy(BTC_64K, 2_200, 24));
  expect(held.verdict).toBe("needs_approval");
  await settled();
  expect(webhook.received).toHaveLength(2);

  const late = await chain.agent.proposeTrade(noBuy(BTC_65K, 600, 31));
  await createTestClient({ mode: "anvil", transport: http(chain.anvil.rpcUrl) }).increaseTime({
    seconds: 600,
  });
  await chain.executor.recordResult({ intentId: late.intentId, filled: true, filledCents: 600, pnlCents: 0 });
  const all = await received(3);
  expect(all[2]).toMatchObject({
    kind: "order_filled",
    detail: { intents: [{ id: late.intentId, market: BTC_65K, filledCents: 600, pnlCents: 0 }] },
  });
});

test("the owner's kill switch in the console sends one event", async ({ page }) => {
  await open(page, "/");
  const isolator = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await isolator.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("paused-banner")).toBeVisible();
  const all = await received(4);
  expect(all[3]).toMatchObject({
    kind: "mandate_changed",
    summary: "The owner paused the agent.",
    detail: { change: "paused", paused: true },
    link: `${baseURL}/rules`,
  });
});

test("spot falling below the floor of the agent's plan sends one event", async () => {
  const request = await recordedPlanRequest({
    quantity: "0.05",
    dropPercent: 3,
    maxCostCents: 5_000,
    maxTradeCents: 2_500,
    remainingBudgetCents: 20_000,
    requestText: "Protect my 0.05 BTC against a 3% fall this week.",
  });
  await agentApi(baseURL, CONSOLE_AGENT_ROUTES.plans, "POST", request);
  const floor = request.plan.floorCents;
  if (floor === null) throw new Error("the plan has no floor");
  // Spot as recorded is above the floor: checks run every second and wake nothing.
  await settled();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(webhook.received).toHaveLength(4);

  gemini.setBtcSpot(floor - 50_000);
  const all = await received(5);
  expect(all[4]).toMatchObject({
    kind: "price_below_floor",
    detail: { asset: "BTC", planId: request.planId, floorCents: floor, spotCents: floor - 50_000 },
    link: `${baseURL}/hedge`,
  });
  // Still below on the next checks: the same fall, never sent again.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(webhook.received).toHaveLength(5);
});

test("past the daily cap, the owner's decision is recorded but not sent", async () => {
  const held = (await snapshot(baseURL)).chain?.intents.find((intent) => intent.status === "needs_approval");
  if (!held) throw new Error("no intent waits for the owner");
  await chain.user.approveIntent(held.id);
  await expect
    .poll(async () => (await snapshot(baseURL)).wake.recent[0], { timeout: 20_000 })
    .toMatchObject({ kind: "owner_decision", status: "capped" });
  const current = await snapshot(baseURL);
  expect(current.wake).toMatchObject({ usedToday: DAILY_CAP, leftToday: 0 });
  expect(webhook.received).toHaveLength(DAILY_CAP);
});

test("exactly one well-formed event per trigger, each with its own id", () => {
  const all = events();
  expect(all.map((event) => event.kind)).toEqual([
    "intent_rejected",
    "intent_rejected",
    "order_filled",
    "mandate_changed",
    "price_below_floor",
  ]);
  expect(new Set(all.map((event) => event.id)).size).toBe(all.length);
  expect(webhook.received.every((request) => request.path === new URL(webhook.url).pathname)).toBe(true);
});

test("the Setup page shows wake-ups in Advanced view only", async ({ page, context }) => {
  await open(page, "/setup");
  await expect(page.getByRole("heading", { name: "Agent pairing" })).toBeVisible();
  await expect(page.getByTestId("wake-ups")).toHaveCount(0);

  await context.addCookies([{ name: "mandate-advanced", value: "on", url: baseURL }]);
  await open(page, "/setup");
  const card = page.getByTestId("wake-ups");
  await expect(card).toHaveAttribute("data-enabled", "true");
  await expect(card).toContainText(`On. 0 of ${DAILY_CAP.toString()} left today (UTC).`);
  await expect(page.getByRole("meter", { name: "Wake-ups left today" })).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  const rows = card.getByTestId("wake-up");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute("data-status", "capped");
  await expect(rows.first()).toContainText("The owner approved");
  await expect(rows.first().getByText("Not sent", { exact: true })).toBeVisible();
  await expect(rows.first()).toContainText("today's cap was reached");
  await expect(card.locator('[data-kind="price_below_floor"]')).toContainText("HTTP 200");
  await expect(card).toContainText("Spot is checked against the current goal every 1 s");
  const text = await page.locator("main").innerText();
  expect(text).not.toContain("e2e-secret-path");
  expect(text).not.toContain(webhook.key);
});

test("a restarted console resends nothing", async () => {
  const before = (await snapshot(baseURL)).wake.recent.map((d) => [d.id, d.status, d.count]);
  await stopConsole();
  await startConsole();
  await settled();
  // Price checks ran again on the restarted console (spot still below the floor).
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const after = await snapshot(baseURL);
  expect(webhook.received).toHaveLength(DAILY_CAP);
  expect(after.wake.recent.map((d) => [d.id, d.status, d.count])).toEqual(before);
  expect(after.wake.lastPriceCheckAt).not.toBeNull();
});

test("neither the webhook's secret path nor its key reaches the console's output or snapshot", async () => {
  const body = JSON.stringify(await snapshot(baseURL));
  for (const seen of [output, body]) {
    expect(seen).not.toContain("e2e-secret-path");
    expect(seen).not.toContain(webhook.key);
  }
  expect(output).toContain("sent: HTTP 200");
});
