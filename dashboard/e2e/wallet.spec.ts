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

/** A stand-in browser wallet extension: who it says it is, its account, and the network it starts on. */
interface StandInWallet {
  name: string;
  rdns: string;
  account: string;
  startChainId: number;
  /**
   * A wallet that is locked, asleep or busy, as MetaMask can be: it answers nothing until the person opens
   * it, which the site's request to connect does (`eth_requestAccounts`, `wallet_requestPermissions`), or
   * until the test wakes it (`wakeWallet`). Its pending requests are answered then.
   */
  asleep?: boolean;
}

/** Each stand-in's icon, a data URI as wallets announce them: a coloured square. */
function iconOf(colour: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colour}"/></svg>`,
  )}`;
}

const METAMASK = { name: "MetaMask", rdns: "io.metamask", icon: iconOf("#f6851b") };
const PHANTOM = { name: "Phantom", rdns: "app.phantom", icon: iconOf("#ab9ff2") };

/**
 * Installs browser wallets as extensions do. Each has an account, a network it starts on, and the networks
 * it knows: switching to an unknown network fails with 4902, as MetaMask does, until
 * `wallet_addEthereumChain` adds it. Transactions go to the chain through anvil, which signs for its own
 * accounts. With `announce`, each wallet announces itself (EIP-6963) and answers a request to; `legacy`
 * names the one that also claims `window.ethereum`, as the last extension to load does. Every request a
 * wallet gets is kept in `window.__walletCalls[rdns]`; `window.__wakeWallet[rdns]` wakes an asleep one.
 */
async function installWallets(
  page: Page,
  wallets: (StandInWallet & { icon: string })[],
  options: { rpcUrl: string; announce: boolean; legacy: string | null },
) {
  await page.addInitScript(
    (setup) => {
      const allCalls: Record<string, { method: string; params: unknown }[]> = {};
      const wakers: Record<string, () => void> = {};
      // A wallet keeps one uuid for the page's life and announces it every time it is asked.
      const providers = setup.wallets.map((wallet) => ({
        wallet,
        uuid: crypto.randomUUID(),
        provider: standIn(wallet, (allCalls[wallet.rdns] = [])),
      }));
      Object.assign(window, { __walletCalls: allCalls, __wakeWallet: wakers });
      const legacy = providers.find(({ wallet }) => wallet.rdns === setup.legacy);
      if (legacy) Object.assign(window, { ethereum: legacy.provider });
      if (setup.announce) {
        const announce = () => {
          for (const { wallet, uuid, provider } of providers) {
            const info = {
              uuid,
              name: wallet.name,
              icon: wallet.icon,
              rdns: wallet.rdns,
            };
            window.dispatchEvent(
              new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
            );
          }
        };
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      }

      function standIn(wallet: (typeof setup.wallets)[number], calls: { method: string; params: unknown }[]) {
        type Listener = (value: unknown) => void;
        const listeners = new Map<string, Set<Listener>>();
        const known = new Set<number>([wallet.startChainId]);
        let chainId = wallet.startChainId;
        const hex = (value: number) => `0x${value.toString(16)}`;
        const emit = (event: string, value: unknown) => {
          for (const listener of listeners.get(event) ?? []) listener(value);
        };
        const fail = (code: number, message: string) => Object.assign(new Error(message), { code });
        let awake = wallet.asleep !== true;
        const waiting: (() => void)[] = [];
        const wake = () => {
          awake = true;
          for (const answer of waiting.splice(0)) answer();
        };
        wakers[wallet.rdns] = wake;
        const permission = `stand-in-wallet:${wallet.rdns}:permitted`;
        const permitted = () => localStorage.getItem(permission) === "1";
        const permit = (allowed: boolean) =>
          allowed ? localStorage.setItem(permission, "1") : localStorage.removeItem(permission);
        let rpcId = 0;
        const forward = async (method: string, params: unknown) => {
          if (chainId !== setup.chainOfRpc)
            throw fail(4900, "the stand-in wallet only reaches the test chain");
          const response = await fetch(setup.rpcUrl, {
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
          isMetaMask: wallet.rdns === "io.metamask",
          isPhantom: wallet.rdns === "app.phantom",
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
            // Asking to connect opens the wallet, as a locked MetaMask asks to be unlocked; nothing else does.
            if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") wake();
            if (!awake) await new Promise<void>((answer) => waiting.push(answer));
            switch (method) {
              case "eth_chainId":
                return hex(chainId);
              case "net_version":
                return String(chainId);
              // As a real extension, a wallet shows its account to a site only once the person allowed it,
              // and remembers that across reloads until the site revokes it.
              case "eth_accounts":
                return permitted() ? [wallet.account] : [];
              case "eth_requestAccounts":
                permit(true);
                return [wallet.account];
              case "wallet_requestPermissions":
                permit(true);
                return [{ parentCapability: "eth_accounts" }];
              case "wallet_getPermissions":
                return permitted() ? [{ parentCapability: "eth_accounts" }] : [];
              case "wallet_revokePermissions":
                permit(false);
                return null;
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
        return provider;
      }
    },
    { wallets, ...options, chainOfRpc: CHAIN_ID },
  );
}

/** The requests one stand-in wallet has had since the page loaded. */
async function walletCalls(page: Page, rdns: string): Promise<{ method: string; params: unknown }[]> {
  return page.evaluate(
    (name) =>
      (window as unknown as { __walletCalls: Record<string, { method: string; params: unknown }[]> })
        .__walletCalls[name] ?? [],
    rdns,
  );
}

function methods(calls: { method: string }[]): string[] {
  return calls.map((call) => call.method);
}

/** Wakes an asleep stand-in wallet: it answers its pending requests, late, as an unlocked wallet does. */
async function wakeWallet(page: Page, rdns: string) {
  await page.evaluate((name) => {
    (window as unknown as { __wakeWallet: Record<string, () => void> }).__wakeWallet[name]?.();
  }, rdns);
}

/**
 * What a browser remembers from an earlier visit, set once before the first page loads (a reload keeps
 * it): the wallet the console connected last, and each wallet's permission for the site.
 */
async function rememberVisit(page: Page, stored: { recent: string; permitted: string[]; legacy?: boolean }) {
  await page.addInitScript((visit) => {
    if (sessionStorage.getItem("stand-in-visit")) return;
    sessionStorage.setItem("stand-in-visit", "1");
    localStorage.setItem("wagmi.recentConnectorId", JSON.stringify(visit.recent));
    // The console before the chooser connected through `window.ethereum`, and marked it so.
    if (visit.legacy) localStorage.setItem("wagmi.injected.connected", "true");
    for (const rdns of visit.permitted) localStorage.setItem(`stand-in-wallet:${rdns}:permitted`, "1");
  }, stored);
}

/** The wallet control never stays a placeholder: no skeleton, and nothing on the page left busy. */
async function expectActionable(page: Page) {
  await expect(page.locator('[data-wallet-state="loading"]')).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("a wallet on another network is asked to switch, and to add the console's network, before it can sign", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  // A wallet that only sets `window.ethereum` and never announces itself: the console falls back to it.
  await installWallets(page, [{ ...METAMASK, account: owner, startChainId: WALLET_START_CHAIN }], {
    rpcUrl: chain.anvil.rpcUrl,
    announce: false,
    legacy: METAMASK.rdns,
  });
  await page.goto(await firstMandatePath(baseURL));

  // This build has no dev signer: nothing connects until the owner asks.
  await expect(page.getByTestId("dev-signer-badge")).toHaveCount(0);
  // The setup checklist names connecting the wallet as the step to do now, with the button that does it.
  const now = page.getByTestId("get-started-now").filter({ visible: true });
  await expect(now).toContainText("Next: Connect your wallet");
  await now.getByRole("button", { name: "Connect wallet" }).click();

  // Connected on the wrong network: one clear step, and no owner control can send anything meanwhile.
  const switchButton = page
    .getByRole("banner")
    .getByRole("button", { name: "Switch to Local dev chain" })
    .filter({ visible: true });
  await expect(switchButton).toBeVisible();
  await expect(now.getByRole("button", { name: "Switch to Local dev chain" })).toBeVisible();
  const pause = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await expect(pause).toBeDisabled();
  await expect(
    page.locator('[title="Switch your wallet to Local dev chain to sign."]').first(),
  ).toBeAttached();
  await expect(page.getByTestId("wallet-notice")).toContainText(
    "Your wallet is on another network, so approving, rejecting, changing the rules and pausing are off",
  );
  expect(methods(await walletCalls(page, METAMASK.rdns))).not.toContain("eth_sendTransaction");

  // The wallet has never heard of the network: the console adds it, with what the wallet needs to show it.
  await switchButton.click();
  await expect(page.getByTestId("owner-address").filter({ visible: true })).toHaveAttribute(
    "data-owner",
    "true",
  );
  await expect(page.getByTestId("wallet-notice")).toHaveCount(0);
  const calls = await walletCalls(page, METAMASK.rdns);
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
  const sent = (await walletCalls(page, METAMASK.rdns)).filter(
    (call) => call.method === "eth_sendTransaction",
  );
  expect(sent).toHaveLength(1);
});

test("with two wallets in the browser, the owner picks one, the console remembers it, and only that one signs", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  const stranger = devAccount("outsider").address;
  // MetaMask holds the owner's account; Phantom, loaded last, holds another and claims `window.ethereum`.
  await installWallets(
    page,
    [
      { ...METAMASK, account: owner, startChainId: CHAIN_ID },
      { ...PHANTOM, account: stranger, startChainId: CHAIN_ID },
    ],
    { rpcUrl: chain.anvil.rpcUrl, announce: true, legacy: PHANTOM.rdns },
  );
  await page.goto(await firstMandatePath(baseURL));
  // The first test paused the agent: here the owner resumes it.
  await expect(page.getByTestId("paused-banner")).toBeVisible();

  // Both wallets answered, so the console asks which, with each one's own name and icon.
  const connect = page
    .getByRole("banner")
    .getByRole("button", { name: "Connect wallet" })
    .filter({ visible: true });
  await connect.click();
  const chooser = page.getByRole("dialog", { name: "Choose a wallet" });
  await expect(chooser).toBeVisible();
  const choices = chooser.getByTestId("wallet-choice");
  await expect(choices).toHaveText(["MetaMask", "Phantom"]);
  await expect(chooser.getByRole("button", { name: "MetaMask" }).locator("img")).toHaveAttribute(
    "src",
    METAMASK.icon,
  );
  await expect(chooser.getByRole("button", { name: "Phantom" }).locator("img")).toHaveAttribute(
    "src",
    PHANTOM.icon,
  );
  // Nothing has asked either wallet for its accounts yet.
  expect(methods(await walletCalls(page, METAMASK.rdns))).not.toContain("eth_requestAccounts");
  expect(methods(await walletCalls(page, PHANTOM.rdns))).not.toContain("eth_requestAccounts");

  // Phantom's account is not the owner: the console says so, and names the account the contract does.
  await chooser.getByRole("button", { name: "Phantom" }).click();
  await expect(chooser).toBeHidden();
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", stranger);
  await expect(chip).toHaveAttribute("data-owner", "false");
  await expect(page.getByTestId("wallet-notice")).toContainText(`the Policy contract names ${owner}`);
  const resume = page.getByRole("button", { name: /Resume agent/ }).filter({ visible: true });
  await expect(resume).toBeDisabled();
  expect(methods(await walletCalls(page, METAMASK.rdns))).not.toContain("eth_requestAccounts");

  // The owner disconnects and picks MetaMask instead.
  await chip.click();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await connect.click();
  await chooser.getByRole("button", { name: "MetaMask" }).click();
  await expect(chip).toHaveAttribute("data-address", owner);
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(page.getByTestId("wallet-notice")).toHaveCount(0);

  // The choice is remembered: after a reload MetaMask reconnects, with no chooser and no click.
  await page.reload();
  await expect(chip).toHaveAttribute("data-address", owner);
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(chooser).toHaveCount(0);

  // The owner resumes the agent, and only MetaMask is asked to send it.
  await expect(resume).toBeEnabled();
  await resume.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("paused-banner")).toBeHidden();
  expect((await snapshot(baseURL)).chain?.paused).toBe(false);
  expect(
    methods(await walletCalls(page, METAMASK.rdns)).filter((method) => method === "eth_sendTransaction"),
  ).toHaveLength(1);
  expect(methods(await walletCalls(page, PHANTOM.rdns))).not.toContain("eth_sendTransaction");
});

test("from Home, the owner's first screen, the owner connects the wallet without looking for where", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  await installWallets(page, [{ ...METAMASK, account: owner, startChainId: WALLET_START_CHAIN }], {
    rpcUrl: chain.anvil.rpcUrl,
    announce: true,
    legacy: METAMASK.rdns,
  });
  // Where a claim lands.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  // The wallet-owned mandate says what is missing, with the action, on its own row.
  const row = page.getByTestId("mandate-row").first();
  const line = row.getByTestId("mandate-owner-line");
  await expect(line).toContainText("Connect the owner wallet to approve and change rules");
  await line.getByRole("button", { name: "Connect wallet" }).click();

  // On another network: Home asks to switch, as a mandate's top bar does.
  await expect(line).toContainText("Switch the wallet to Local dev chain to approve and change rules");
  await page.getByRole("button", { name: "Switch to Local dev chain" }).click();
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", owner);
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(line).toContainText("is the owner and signs");

  // The mandate's pages find the wallet connected, with nothing left to connect.
  await row.getByRole("link", { name: /^Open / }).click();
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(page.getByTestId("get-started-now")).toHaveCount(0);
  await expect(page.getByTestId("wallet-notice")).toHaveCount(0);
});

test("a remembered wallet that never answers: within the deadline the console offers to connect, says why, and connecting wakes it", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  await rememberVisit(page, { recent: METAMASK.rdns, permitted: [METAMASK.rdns] });
  await installWallets(page, [{ ...METAMASK, account: owner, startChainId: CHAIN_ID, asleep: true }], {
    rpcUrl: chain.anvil.rpcUrl,
    announce: true,
    legacy: METAMASK.rdns,
  });

  // Home: the restore asked MetaMask for its accounts and had no answer; the owner can still act.
  await page.goto("/");
  // The header's control (the mandate's row has a Connect button of its own, below).
  const top = page.getByRole("main").locator("header").getByRole("button", { name: "Connect wallet" });
  await expect(top).toBeVisible();
  const line = page.getByTestId("mandate-row").first().getByTestId("mandate-owner-line");
  await expect(line).toContainText(
    "MetaMask did not answer. Open it to unlock, then connect the owner wallet",
  );
  await expectActionable(page);
  expect(methods(await walletCalls(page, METAMASK.rdns))).toContain("eth_accounts");
  expect(methods(await walletCalls(page, METAMASK.rdns))).not.toContain("eth_requestAccounts");

  // In a mandate: the top bar offers to connect, the page says which wallet did not answer, and the pause
  // control says why it is off.
  await page.goto(await firstMandatePath(baseURL));
  const connect = page
    .getByRole("banner")
    .getByRole("button", { name: "Connect wallet" })
    .filter({ visible: true });
  await expect(connect).toBeVisible();
  await expect(page.getByTestId("wallet-notice")).toHaveText(
    "MetaMask did not answer. Open it to unlock, then press \u201cConnect wallet\u201d.",
  );
  const pause = page.getByRole("button", { name: /Pause agent/ }).filter({ visible: true });
  await expect(pause).toBeDisabled();
  await expect(page.locator("span[title]", { has: pause })).toHaveAttribute(
    "title",
    "Connect the owner wallet to sign.",
  );
  await expectActionable(page);

  // Connecting is the request that opens the wallet: it answers, and the owner signs.
  await connect.click();
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", owner);
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(page.getByTestId("wallet-notice")).toHaveCount(0);
  await expect(pause).toBeEnabled();
  expect(methods(await walletCalls(page, METAMASK.rdns))).toContain("eth_requestAccounts");
});

test("a remembered wallet that answers late connects by itself, with no click", async ({ page }) => {
  const owner = devAccount("user").address;
  await rememberVisit(page, { recent: METAMASK.rdns, permitted: [METAMASK.rdns] });
  await installWallets(page, [{ ...METAMASK, account: owner, startChainId: CHAIN_ID, asleep: true }], {
    rpcUrl: chain.anvil.rpcUrl,
    announce: true,
    legacy: METAMASK.rdns,
  });
  await page.goto(await firstMandatePath(baseURL));
  await expect(page.getByTestId("wallet-notice")).toContainText("MetaMask did not answer");
  await expectActionable(page);

  // The owner unlocks MetaMask from its own window: the restore's request is answered, and it connects.
  await wakeWallet(page, METAMASK.rdns);
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", owner);
  await expect(chip).toHaveAttribute("data-owner", "true");
  await expect(page.getByTestId("wallet-notice")).toHaveCount(0);
  expect(methods(await walletCalls(page, METAMASK.rdns))).not.toContain("eth_requestAccounts");
});

test("a wallet the owner picked while another did not answer stays the one connected when that one answers", async ({
  page,
}) => {
  const owner = devAccount("user").address;
  const stranger = devAccount("outsider").address;
  await rememberVisit(page, { recent: METAMASK.rdns, permitted: [METAMASK.rdns] });
  await installWallets(
    page,
    [
      { ...METAMASK, account: owner, startChainId: CHAIN_ID, asleep: true },
      { ...PHANTOM, account: stranger, startChainId: CHAIN_ID },
    ],
    { rpcUrl: chain.anvil.rpcUrl, announce: true, legacy: PHANTOM.rdns },
  );
  await page.goto(await firstMandatePath(baseURL));
  const connect = page
    .getByRole("banner")
    .getByRole("button", { name: "Connect wallet" })
    .filter({ visible: true });
  await connect.click();
  await page
    .getByRole("dialog", { name: "Choose a wallet" })
    .getByRole("button", { name: "Phantom" })
    .click();
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", stranger);

  // MetaMask answers the restore's request now. The console keeps both connections, and Phantom's current.
  await wakeWallet(page, METAMASK.rdns);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = localStorage.getItem("wagmi.store") ?? "";
        return store.includes('"id":"io.metamask"') && store.includes('"id":"app.phantom"');
      }),
    )
    .toBe(true);
  await expect(chip).toHaveAttribute("data-address", stranger);
  await expect(chip).toHaveAttribute("data-owner", "false");
});

test("a wallet remembered from before the chooser reconnects under its own name", async ({ page }) => {
  const owner = devAccount("user").address;
  const stranger = devAccount("outsider").address;
  // The console once connected MetaMask through `window.ethereum` and remembered it as "injected".
  await rememberVisit(page, { recent: "injected", permitted: [METAMASK.rdns], legacy: true });
  await installWallets(
    page,
    [
      { ...METAMASK, account: owner, startChainId: CHAIN_ID },
      { ...PHANTOM, account: stranger, startChainId: CHAIN_ID },
    ],
    { rpcUrl: chain.anvil.rpcUrl, announce: true, legacy: METAMASK.rdns },
  );
  await page.goto(await firstMandatePath(baseURL));
  const chip = page.getByTestId("owner-address").filter({ visible: true });
  await expect(chip).toHaveAttribute("data-address", owner);
  await chip.click();
  await expect(page.getByRole("dialog", { name: "Owner wallet" })).toContainText(
    "MetaMask, a browser wallet",
  );
  // The entry from before the chooser is gone, so it never stands in for an announced wallet again.
  expect(
    await page.evaluate(() => [
      localStorage.getItem("wagmi.recentConnectorId"),
      localStorage.getItem("wagmi.injected.connected"),
    ]),
  ).toEqual([null, null]);
  expect(methods(await walletCalls(page, PHANTOM.rdns))).not.toContain("eth_requestAccounts");
});
