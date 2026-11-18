import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { type Page, expect, test } from "@playwright/test";

import {
  CONSOLE_AGENT_ROUTES,
  type ExecutorVenue,
  type FillSource,
  ordersResponseSchema,
  quantityHundredthsFromAmount,
} from "@mandate/shared";
import { DEMO_POLICY, announceVenue, consoleOrderJournal, devAccount } from "@mandate/devchain";

import {
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
  firstMandatePath,
  ownerHeaders,
  waitForConsole,
  waitForSnapshot,
} from "./support/console";
import { claimOwnerOnce, forgetOwner, signInAsOwner } from "./support/session";

/**
 * The console as the hosted Arc demo runs it: a Policy contract configured by address (`POLICY_ADDRESS`,
 * which the console reads as Arc testnet; here its RPC is a local anvil with Arc's chain id), no dev signer,
 * and an executor that fills on the simulated venue. The chain is real, the fills are not: every page that
 * shows a fill must say so, from the venue the executor announced, never from the chain. Before it
 * announces one, the console says the fill source is unknown.
 */

const PORT = Number(process.env.E2E_ARC_PORT ?? 3105);
const CHAIN_PORT = Number(process.env.E2E_ARC_CHAIN_PORT ?? 8649);
const baseURL = `http://localhost:${PORT.toString()}`;

test.describe.configure({ mode: "serial" });
test.use({ baseURL, viewport: { width: 1440, height: 900 } });

const paths = suitePaths("arc");
let chain: TestChain;
let server: ChildProcess | null = null;
let filledId: number;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  freshSuiteDir("arc");
  forgetOwner(baseURL);
  chain = await startTestChain({ port: CHAIN_PORT, deploymentFile: paths.deploymentFile });
  await chain.user.setPolicy(DEMO_POLICY);
  filledId = (await chain.agent.proposeTrade(noBuy(BTC_65K, 500, 31))).intentId;
  await chain.executor.recordResult({ intentId: filledId, filled: true, filledCents: 500, pnlCents: 0 });

  await startConsole();
  await claimOwnerOnce(baseURL, paths.dataDir);
  const ready = await waitForSnapshot(
    baseURL,
    (current) =>
      current.feed.health === "live" &&
      (current.chain?.intents.some((intent) => intent.id === filledId && intent.status === "executed") ??
        false),
    120_000,
  );
  expect(ready.network.kind).toBe("arc-testnet");
  for (const path of ["", "/activity", `/activity/${filledId.toString()}`]) {
    const response = await fetch(new URL(await firstMandatePath(baseURL, path), baseURL), {
      headers: ownerHeaders(baseURL),
    });
    await response.arrayBuffer();
  }
  await (await fetch(new URL(`/agent/${devAccount("agent").address}`, baseURL))).arrayBuffer();
});

test.beforeEach(async ({ context }) => {
  await signInAsOwner(context, baseURL);
});

test.afterAll(async () => {
  await stopConsole();
  await chain.anvil.stop();
});

/**
 * Starts the console as the hosted Arc demo runs it, on the simulated venue unless `venue` says otherwise:
 * the hosted switch to Gemini's sandbox restarts every service with EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox.
 */
async function startConsole(venue: Record<string, string> = { EXECUTOR_VENUE: "simulated" }) {
  const output = openSync(join(paths.dir, "next-dev.log"), "a");
  server = spawn("npx", ["next", "dev", "--port", PORT.toString()], {
    cwd: DASHBOARD_DIR,
    detached: true,
    stdio: ["ignore", output, "inherit"],
    env: {
      ...process.env,
      NEXT_PUBLIC_DEV_SIGNER: "0",
      // Configured by address, as on Arc: the console takes it for Arc testnet.
      POLICY_ADDRESS: chain.address,
      POLICY_DEPLOY_BLOCK: "0",
      ARC_RPC_URL: chain.anvil.rpcUrl,
      POLICY_DEPLOYMENT_FILE: "",
      CONSOLE_DATA_DIR: paths.dataDir,
      CONSOLE_EVENT_SOURCE: "rpc",
      CONSOLE_SERVICE_TOKEN: E2E_SERVICE_TOKEN,
      CONSOLE_URL: baseURL,
      MCP_PUBLIC_URL: "",
      MCP_PORT: "9",
      GEMINI_API_URL: "http://127.0.0.1:9",
      NEXT_DEV_CACHE: "off",
      ...venue,
    },
  });
  closeSync(output);
  await waitForConsole(baseURL, 180_000);
}

async function stopConsole() {
  const running = server;
  server = null;
  if (running?.pid) {
    const exited = new Promise((resolve) => running.once("exit", resolve));
    process.kill(-running.pid, "SIGTERM");
    await exited;
  }
}

/** Signs an executor record with the executor key, as the executor does. */
const executorSign = (hash: `0x${string}`) => devAccount("executor").signMessage({ message: { raw: hash } });

function badge(page: Page) {
  return page.getByTestId("venue-badge").filter({ visible: true });
}

test("on Arc, before the executor names its venue, every fill says its source is unknown", async ({
  page,
}) => {
  await page.goto(await firstMandatePath(baseURL));
  await expect(badge(page)).toHaveAttribute("data-venue", "unknown");
  await expect(badge(page)).toHaveText("Fill source unknown");

  await page.goto(await firstMandatePath(baseURL, "/activity"));
  await expect(page.getByTestId("unknown-fill").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("simulated-fill")).toHaveCount(0);
});

test("on Arc with the simulated venue, the top bar, Activity, the intent, Audit and the public scorecard say the fills are simulated", async ({
  page,
}) => {
  const sign = executorSign;
  expect(
    await announceVenue(
      { consoleUrl: baseURL, sign },
      {
        kind: "executor-venue",
        version: 1,
        chainId: chain.executor.publicClient.chain.id,
        policy: chain.address.toLowerCase() as `0x${string}`,
        venue: "simulated",
        environment: null,
        announcedAt: new Date().toISOString(),
      },
    ),
  ).toBeNull();

  await page.goto(await firstMandatePath(baseURL));
  await expect(badge(page)).toHaveAttribute("data-venue", "simulated");
  await expect(badge(page)).toHaveText("Simulated fills");

  await page.goto(await firstMandatePath(baseURL, "/activity"));
  await expect(page.getByTestId("simulated-fill").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("unknown-fill")).toHaveCount(0);

  await page.goto(await firstMandatePath(baseURL, `/activity/${filledId.toString()}`));
  const timeline = page.getByTestId("intent-timeline");
  await expect(timeline.getByTestId("simulated-fill")).toBeVisible();

  // Audit keeps the onchain record word for word, and tags the fill row with where it was filled.
  await page.goto(await firstMandatePath(baseURL, "/audit"));
  await expect(page.getByTestId("simulated-fill").filter({ visible: true }).first()).toBeVisible();

  await page.goto(`/agent/${devAccount("agent").address}`);
  await expect(page.getByTestId("count-filled").getByTestId("simulated-fill")).toBeVisible();
});

test("after the switch to Gemini's sandbox, earlier fills still say simulated and the new fill says sandbox, everywhere", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The hosted switch: every service restarts on Gemini's sandbox, on the same contract and database.
  await stopConsole();
  await startConsole({ EXECUTOR_VENUE: "gemini", GEMINI_ENV: "sandbox" });
  await waitForSnapshot(baseURL, (current) => current.feed.health === "live", 120_000);

  const chainId = chain.executor.publicClient.chain.id;
  const policy = chain.address.toLowerCase() as `0x${string}`;
  const sandbox: ExecutorVenue = {
    kind: "executor-venue",
    version: 1,
    chainId,
    policy,
    venue: "gemini",
    environment: "sandbox",
    announcedAt: new Date().toISOString(),
  };
  expect(await announceVenue({ consoleUrl: baseURL, sign: executorSign }, sandbox)).toBeNull();

  // A sandbox fill: the executor journals the order before it is placed, then records the fill onchain.
  const amountCents = 620;
  const sandboxId = (await chain.agent.proposeTrade(noBuy(BTC_65K, amountCents, 31))).intentId;
  await waitForSnapshot(
    baseURL,
    (current) => current.chain?.intents.some((intent) => intent.id === sandboxId) ?? false,
    60_000,
  );
  const quantity = quantityHundredthsFromAmount(amountCents, 31);
  const at = new Date().toISOString();
  await consoleOrderJournal({ consoleUrl: baseURL, sign: executorSign, deployment: { chainId, policy } }).put(
    {
      kind: "venue-order",
      version: 1,
      chainId,
      policy,
      intentId: sandboxId,
      revision: 1,
      venue: "gemini",
      environment: "sandbox",
      clientOrderId: `m-e2e-${sandboxId.toString()}`,
      market: BTC_65K,
      side: "buy",
      outcome: "NO",
      quantityHundredths: quantity,
      limitPrice: 31,
      state: "filled",
      venueOrderId: "7001",
      filledHundredths: quantity,
      filledCents: amountCents,
      feeCents: 4,
      detail: null,
      placedAt: at,
      updatedAt: at,
    },
  );
  await chain.executor.recordResult({
    intentId: sandboxId,
    filled: true,
    filledCents: amountCents,
    pnlCents: 0,
  });
  await waitForSnapshot(
    baseURL,
    (current) =>
      (current.chain?.intents.some((intent) => intent.id === sandboxId && intent.status === "executed") ??
        false) &&
      current.chain?.venueOrders[sandboxId] !== undefined,
    60_000,
  );

  // The top bar states the venue now.
  await page.goto(await firstMandatePath(baseURL));
  await expect(badge(page)).toHaveAttribute("data-venue", "sandbox");

  // Activity's Filled total says each source's share, never one tag for both.
  await page.goto(await firstMandatePath(baseURL, "/activity"));
  const shares = page.getByTestId("fill-shares").filter({ visible: true }).first();
  await expect(shares.getByTestId("simulated-fill")).toHaveText("1 simulated");
  await expect(shares.getByTestId("sandbox-fill")).toHaveText("1 on the sandbox");

  // Each intent keeps its own source.
  await page.goto(await firstMandatePath(baseURL, `/activity/${filledId.toString()}`));
  await expect(page.getByTestId("intent-timeline").getByTestId("simulated-fill")).toBeVisible();
  await expect(page.getByTestId("intent-timeline").getByTestId("sandbox-fill")).toHaveCount(0);
  await page.goto(await firstMandatePath(baseURL, `/activity/${sandboxId.toString()}`));
  await expect(page.getByTestId("intent-timeline").getByTestId("sandbox-fill")).toBeVisible();
  await expect(page.getByTestId("intent-timeline").getByTestId("simulated-fill")).toHaveCount(0);

  // Audit tags each fill row with its own source.
  await page.goto(await firstMandatePath(baseURL, "/audit"));
  await expect(page.getByTestId("simulated-fill").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByTestId("sandbox-fill").filter({ visible: true })).toHaveCount(1);

  // The public scorecard splits its Filled count the same way.
  await page.goto(`/agent/${devAccount("agent").address}`);
  const filled = page.getByTestId("count-filled");
  await expect(filled.getByTestId("simulated-fill")).toHaveText("1 simulated");
  await expect(filled.getByTestId("sandbox-fill")).toHaveText("1 on the sandbox");

  // The MCP server reads each fill's source from the console's orders route.
  const orders = ordersResponseSchema.parse(await agentApi(baseURL, CONSOLE_AGENT_ROUTES.orders, "GET"));
  expect(orders.venue).toEqual({ venue: "gemini", environment: "sandbox" });
  expect(orders.fillSources).toEqual([
    { intentId: filledId, source: "simulated" satisfies FillSource },
    { intentId: sandboxId, source: "sandbox" satisfies FillSource },
  ]);
});
