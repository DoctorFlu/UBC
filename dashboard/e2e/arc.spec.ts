import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { type Page, expect, test } from "@playwright/test";

import { DEMO_POLICY, announceVenue, devAccount } from "@mandate/devchain";

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

const PORT = Number(process.env.E2E_ARC_PORT ?? 3104);
const CHAIN_PORT = Number(process.env.E2E_ARC_CHAIN_PORT ?? 8648);
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
      EXECUTOR_VENUE: "simulated",
      NEXT_DEV_CACHE: "off",
    },
  });
  closeSync(output);
  await waitForConsole(baseURL, 180_000);
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
  const running = server;
  server = null;
  if (running?.pid) {
    const exited = new Promise((resolve) => running.once("exit", resolve));
    process.kill(-running.pid, "SIGTERM");
    await exited;
  }
  await chain.anvil.stop();
});

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

test("on Arc with the simulated venue, the top bar, Activity, the intent and the public scorecard say the fills are simulated", async ({
  page,
}) => {
  const sign = (hash: `0x${string}`) => devAccount("executor").signMessage({ message: { raw: hash } });
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

  await page.goto(`/agent/${devAccount("agent").address}`);
  await expect(page.getByTestId("count-filled").getByTestId("simulated-fill")).toBeVisible();
});
