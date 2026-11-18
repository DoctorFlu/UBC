import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { type Page, expect, test } from "@playwright/test";

import { devAccount } from "@mandate/devchain";
import { ARC_TESTNET_CHAIN_ID } from "@mandate/shared";
import { numberToHex } from "viem";

import { DASHBOARD_DIR, type TestChain, freshSuiteDir, startTestChain, suitePaths } from "./support/chain";
import {
  E2E_SERVICE_TOKEN,
  firstMandatePath,
  ownerHeaders,
  snapshot,
  waitForConsole,
  waitForSnapshot,
} from "./support/console";
import { claimOwnerOnce, forgetOwner, signInAsOwner } from "./support/session";

/**
 * The owner's first visit with a real browser wallet, as on Arc testnet: a console built without the dev
 * signer, and a wallet (a stand-in for MetaMask, below) that is on another network and has never heard of
 * the console's. The console must ask to switch, add the network when the wallet does not know it, and only
 * then let the owner sign; before that, no owner control can send a transaction to the wrong chain.
 */

const PORT = Number(process.env.E2E_WALLET_PORT ?? 3103);
const CHAIN_PORT = Number(process.env.E2E_WALLET_CHAIN_PORT ?? 8647);
const baseURL = `http://localhost:${PORT.toString()}`;
/** Ethereum mainnet: where a fresh MetaMask starts. */
const WALLET_START_CHAIN = 1;

test.describe.configure({ mode: "serial" });
test.use({ baseURL, viewport: { width: 1440, height: 900 } });

const paths = suitePaths("wallet");
/** The test chain's id: anvil runs as Arc testnet's (devchain/src/anvil.ts), so the wallet sees the same id. */
const CHAIN_ID = ARC_TESTNET_CHAIN_ID;
let chain: TestChain;
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  freshSuiteDir("wallet");
  forgetOwner(baseURL);
  chain = await startTestChain({ port: CHAIN_PORT, deploymentFile: paths.deploymentFile });
  const output = openSync(join(paths.dir, "next-dev.log"), "a");
  server = spawn("npx", ["next", "dev", "--port", PORT.toString()], {
    cwd: DASHBOARD_DIR,
    detached: true,
    stdio: ["ignore", output, "inherit"],
    env: {
      ...process.env,
      // As the Arc build (deploy/compose.arc.yml): the owner signs with their own wallet.
      NEXT_PUBLIC_DEV_SIGNER: "0",
      POLICY_ADDRESS: "",
      POLICY_DEPLOY_BLOCK: "",
      POLICY_DEPLOYMENT_FILE: paths.deploymentFile,
      CONSOLE_DATA_DIR: paths.dataDir,
      CONSOLE_EVENT_SOURCE: "rpc",
      CONSOLE_SERVICE_TOKEN: E2E_SERVICE_TOKEN,
      CONSOLE_URL: baseURL,
      MCP_PUBLIC_URL: "",
      MCP_PORT: "9",
      // Never the real Gemini; nothing here reads a quote.
      GEMINI_API_URL: "http://127.0.0.1:9",
      NEXT_DEV_CACHE: "off",
    },
  });
  closeSync(output);
  await waitForConsole(baseURL, 180_000);
  await claimOwnerOnce(baseURL, paths.dataDir);
  await waitForSnapshot(baseURL, (current) => current.feed.health === "live", 120_000);
  // Compile the mandate's Overview once, so the test never waits on a cold route.
  const overview = await fetch(new URL(await firstMandatePath(baseURL), baseURL), {
    headers: ownerHeaders(baseURL),
  });
  await overview.arrayBuffer();
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

/**
 * Installs `window.ethereum` as a browser wallet extension does: an account (the contract's owner), a
 * network it starts on, and the networks it knows. Switching to an unknown network fails with 4902, as
 * MetaMask does, until `wallet_addEthereumChain` adds it. Transactions go to the chain through anvil, which
 * signs for its own accounts. Every wallet request is kept in `window.__walletCalls`.
 */
async function installWallet(page: Page, options: { account: string; startChainId: number; rpcUrl: string }) {
  await page.addInitScript(
    (wallet) => {
      type Listener = (value: unknown) => void;
      const listeners = new Map<string, Set<Listener>>();
      const known = new Set<number>([wallet.startChainId]);
      let chainId = wallet.startChainId;
      const calls: { method: string; params: unknown }[] = [];
      const hex = (value: number) => `0x${value.toString(16)}`;
      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      };
      const fail = (code: number, message: string) => Object.assign(new Error(message), { code });
      let rpcId = 0;
      const forward = async (method: string, params: unknown) => {
        if (chainId !== wallet.chainOfRpc)
          throw fail(4900, "the stand-in wallet only reaches the test chain");
        const response = await fetch(wallet.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? [] }),
        });
        const body = (await response.json()) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (body.error) throw fail(body.error.code, body.error.message);
        return body.result;
      };
      const provider = {
        isMetaMask: true,
        on(event: string, listener: Listener) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
          return provider;
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
          return provider;
        },
        async request({ method, params }: { method: string; params?: unknown }) {
          calls.push({ method, params });
          switch (method) {
            case "eth_chainId":
              return hex(chainId);
            case "net_version":
              return String(chainId);
            case "eth_accounts":
            case "eth_requestAccounts":
              return [wallet.account];
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_switchEthereumChain": {
              const target = Number((params as [{ chainId: string }])[0].chainId);
              if (!known.has(target)) throw fail(4902, `Unrecognized chain ID "${hex(target)}".`);
              chainId = target;
              emit("chainChanged", hex(target));
              return null;
            }
            case "wallet_addEthereumChain": {
              const target = Number((params as [{ chainId: string }])[0].chainId);
              known.add(target);
              // MetaMask offers to switch right after adding; the owner accepts.
              chainId = target;
              emit("chainChanged", hex(target));
              return null;
            }
            default:
              return forward(method, params);
          }
        },
      };
      Object.assign(window, { ethereum: provider, __walletCalls: calls });
    },
    { ...options, chainOfRpc: CHAIN_ID },
  );
}

async function walletCalls(page: Page): Promise<{ method: string; params: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __walletCalls: { method: string; params: unknown }[] }).__walletCalls,
  );
}

test("a wallet on another network is asked to switch, and to add the console's network, before it can sign", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  await installWallet(page, { account: owner, startChainId: WALLET_START_CHAIN, rpcUrl: chain.anvil.rpcUrl });
  await page.goto(await firstMandatePath(baseURL));

  // This build has no dev signer: nothing connects until the owner asks.
  await expect(page.getByTestId("dev-signer-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect wallet" }).filter({ visible: true }).click();

  // Connected on the wrong network: one clear step, and no owner control can send anything meanwhile.
  const switchButton = page
    .getByRole("button", { name: "Switch to Local dev chain" })
    .filter({ visible: true });
  await expect(switchButton).toBeVisible();
  const pause = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await expect(pause).toBeDisabled();
  await expect(
    page.locator('[title="Switch your wallet to Local dev chain to sign."]').first(),
  ).toBeAttached();
  expect((await walletCalls(page)).map((call) => call.method)).not.toContain("eth_sendTransaction");

  // The wallet has never heard of the network: the console adds it, with what the wallet needs to show it.
  await switchButton.click();
  await expect(page.getByTestId("owner-address").filter({ visible: true })).toHaveAttribute(
    "data-owner",
    "true",
  );
  const calls = await walletCalls(page);
  const switched = calls.filter((call) => call.method === "wallet_switchEthereumChain");
  expect(switched[0]?.params).toEqual([{ chainId: numberToHex(CHAIN_ID) }]);
  const added = calls.find((call) => call.method === "wallet_addEthereumChain");
  expect(added?.params).toEqual([
    expect.objectContaining({
      chainId: numberToHex(CHAIN_ID),
      chainName: "Local dev chain",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: [chain.anvil.rpcUrl],
    }),
  ]);

  // Now the owner signs, on the console's network, and the contract takes it.
  await expect(pause).toBeEnabled();
  await pause.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("paused-banner")).toBeVisible();
  expect((await snapshot(baseURL)).chain?.paused).toBe(true);
  const sent = (await walletCalls(page)).filter((call) => call.method === "eth_sendTransaction");
  expect(sent).toHaveLength(1);
});
