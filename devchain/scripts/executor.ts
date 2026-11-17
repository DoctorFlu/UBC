/**
 * `npm run dev:executor`: THE EXECUTOR, DEVELOPMENT AND DEMO CHAIN ONLY.
 *
 * Watches the devchain Policy contract for `IntentApproved`. Before acting it checks the intent the way a
 * real executor must (see `src/executor.ts`): a market Gemini does not list, a category Gemini disagrees
 * with, an outcome other than YES or NO, or a limit price outside 1 to 99 is refused and recorded as not
 * filled. When Gemini cannot be reached it waits and tries again rather than act blindly.
 *
 * EXECUTOR_VENUE picks what fills the order:
 * - simulated (default): nothing is placed; every order fills in full at once, with zero profit and loss.
 * - gemini (issue #93): the order is placed on Gemini Prediction Markets with GEMINI_API_KEY and
 *   GEMINI_API_SECRET, on the sandbox (test funds) unless GEMINI_ENV=production and GEMINI_LIVE_TRADING=on.
 *   Live trading is refused here all the same: the devchain's keys are public. Run `npm run gemini:doctor`
 *   first. The order is journaled in the console (`CONSOLE_URL`) before it is sent, so it is never placed
 *   twice, and its id and state show in the console's Advanced view.
 *
 * Once a filled position's market has expired and its outcome is published, it records what the position
 * paid in the console, signed with the executor key (issue #92; see docs/order-lifecycle.md). It refuses to
 * run against anything but the local devchain. Keys are never printed.
 */
import { createGeminiClient, type GeminiClient } from "@mandate/gemini";
import {
  createGeminiPrivateClient,
  GEMINI_HOSTS,
  geminiTradingSettings,
  isGeminiPrivateError,
  type GeminiPrivateClient,
} from "@mandate/gemini/private";
import type { ExecutorVenue } from "@mandate/shared";
import { resolvePolicyDeployment } from "@mandate/shared/node";
import {
  announceVenue,
  consoleOrderJournal,
  consoleSettlementSink,
  devGeminiClient,
  devPolicyClient,
  geminiVenue,
  simulatedVenue,
  startExecutor,
  type RecordSigner,
  type Venue,
} from "../src";
import { executorSettings } from "../src/executor-settings";

function fail(message: string): never {
  console.error(`[executor] ${message}`);
  process.exit(1);
}

let settings: ReturnType<typeof executorSettings>;
try {
  settings = executorSettings(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { fillDelayMs, pollingIntervalMs, settleIntervalMs, consoleUrl, orderTtlMs } = settings;

const deployment = resolvePolicyDeployment();
if (deployment.source !== "devchain") {
  fail("The executor only runs against the local devchain. Unset POLICY_ADDRESS.");
}

const client = devPolicyClient(deployment.rpcUrl, deployment.address, "executor");
const roles = await client.getRoles();
const wallet = client.walletClient;
if (wallet === undefined || roles.executor.toLowerCase() !== client.account?.address.toLowerCase()) {
  fail(`This contract's executor is ${roles.executor}, not the devchain executor account.`);
}
const sign: RecordSigner = (hash) => wallet.signMessage({ account: wallet.account, message: { raw: hash } });
const chainId = client.publicClient.chain.id;
const policy = client.address.toLowerCase() as `0x${string}`;

let venue: Venue;
let announcement: ExecutorVenue;
let describeVenue: string;
if (settings.venue === "gemini") {
  let trading: GeminiPrivateClient;
  let publicClient: GeminiClient;
  try {
    const gemini = geminiTradingSettings(process.env);
    if (gemini.environment === "production") {
      fail(
        "Live trading is refused on the devchain: its owner and agent keys are public test keys, so anyone " +
          "could approve an order. Use GEMINI_ENV=sandbox.",
      );
    }
    if (gemini.credentials === null) {
      fail("EXECUTOR_VENUE=gemini needs GEMINI_API_KEY and GEMINI_API_SECRET. Run npm run gemini:doctor.");
    }
    trading = createGeminiPrivateClient({ environment: gemini.environment, credentials: gemini.credentials });
    // The sandbox lists other strikes than production: the checks and outcomes read the same environment.
    const publicUrl = process.env.GEMINI_API_URL?.trim() || GEMINI_HOSTS[gemini.environment];
    publicClient = createGeminiClient({ maxRetries: 1, timeoutMs: 8_000, baseUrl: publicUrl });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  // One read-only call at start: a key Gemini refuses stops here; terms not accepted are reported, and
  // orders wait (held) until they are.
  try {
    const terms = await trading.termsStatus();
    if (!terms.hasAcceptedLatest) {
      console.warn(
        "[executor] The Gemini sandbox account has not accepted the latest Prediction Markets terms. Accept " +
          "them at https://exchange.sandbox.gemini.com; approved orders wait until then (never accepted from code).",
      );
    }
  } catch (error) {
    if (isGeminiPrivateError(error) && (error.kind === "auth" || error.kind === "nonce")) {
      fail(`Gemini's sandbox refused the key (${error.reason ?? error.kind}). Run npm run gemini:doctor.`);
    }
    console.warn(
      `[executor] Could not read the terms status yet (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  venue = geminiVenue({
    publicClient,
    trading,
    journal: consoleOrderJournal({ consoleUrl, sign }),
    deployment: { chainId, policy },
    orderTtlMs,
  });
  announcement = {
    kind: "executor-venue",
    version: 1,
    chainId,
    policy,
    venue: "gemini",
    environment: trading.environment,
    announcedAt: new Date().toISOString(),
  };
  describeVenue =
    `GEMINI ${trading.environment.toUpperCase()} executor: places approved orders on Gemini's sandbox (test funds), ` +
    `cancels what is unfilled after ${String(Math.round(orderTtlMs / 60_000))} min`;
} else {
  venue = simulatedVenue(devGeminiClient());
  announcement = {
    kind: "executor-venue",
    version: 1,
    chainId,
    policy,
    venue: "simulated",
    environment: null,
    announcedAt: new Date().toISOString(),
  };
  describeVenue = `SIMULATED executor (dev only): places nothing, fills after ${String(fillDelayMs)} ms`;
}

console.log(
  `[executor] ${describeVenue}; watching ${deployment.address}, polling every ${String(pollingIntervalMs ?? 1_000)} ms; ` +
    "checks every approved intent against Gemini first; " +
    `settles expired positions every ${String(settleIntervalMs / 1_000)} s into the console at ${consoleUrl}`,
);

// Tells the console which venue fills orders (its Sandbox badge). The console may start after the
// executor, so this tries again with growing waits until it is stored; it asks nothing of Gemini.
void (async () => {
  for (let attempt = 0; ; attempt += 1) {
    const problem = await announceVenue({ consoleUrl, sign }, announcement);
    if (problem === null) return;
    if (attempt === 0)
      console.warn(`[executor] Could not tell the console its venue yet (${problem}); trying again.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000 * 2 ** attempt, 60_000)));
  }
})();

const executor = startExecutor({
  client,
  venue,
  settlements: consoleSettlementSink({ consoleUrl }),
  fromBlock: deployment.fromBlock ?? 0n,
  fillDelayMs,
  settleIntervalMs,
  ...(pollingIntervalMs === undefined ? {} : { pollingIntervalMs }),
});

process.on("SIGINT", () => {
  executor.stop();
  process.exit(0);
});
