/**
 * `npm run dev:executor`: the executor, for the local devchain, the hosted demo chain and Arc testnet.
 *
 * Which contract and key (`src/executor-target.ts`): the devchain's deployment file with anvil's executor
 * account, or the contract in `POLICY_ADDRESS` with `EXECUTOR_PRIVATE_KEY` (`npm run arc:keygen`), which may
 * not be one of anvil's published keys off a loopback RPC. Until the contract's `executor()` is this key it
 * waits, saying which `setExecutor` call the owner must make, and reads the role again every 30 s.
 *
 * Watches the Policy contract for `IntentApproved`. Before acting it checks the intent the way a
 * real executor must (see `src/executor.ts`): a market Gemini does not list, a category Gemini disagrees
 * with, an outcome other than YES or NO, or a limit price outside 1 to 99 is refused and recorded as not
 * filled. When Gemini cannot be reached it waits and tries again rather than act blindly.
 *
 * EXECUTOR_VENUE picks what fills the order:
 * - simulated (default): nothing is placed; every order fills in full at once, with zero profit and loss.
 * - gemini (issue #93): the order is placed on Gemini Prediction Markets with GEMINI_API_KEY and
 *   GEMINI_API_SECRET, on the sandbox (test funds). Production is refused here whatever GEMINI_ENV and
 *   GEMINI_LIVE_TRADING say: the devchain's keys are public, and on Arc testnet trading stays on the
 *   sandbox. Run `npm run gemini:doctor`
 *   first. The order is journaled in the console (`CONSOLE_URL`) before it is sent, so it is never placed
 *   twice, and its id and state show in the console's Advanced view.
 *
 * Once a filled position's market has expired and its outcome is published, it records what the position
 * paid in the console, signed with the executor key (issue #92; see docs/order-lifecycle.md). Keys are
 * never printed, and of the RPC URL only its host.
 *
 * Settings come from the environment, then from `ENV_FILE` (or the repository's `.env`) for what the
 * environment leaves unset, as `npm run gemini:doctor` reads them; the containers have no such file.
 */
import {
  createMarketDataClient,
  createProductionClient,
  marketDataSource,
  type GeminiClient,
  type MarketDataSource,
} from "@mandate/gemini";
import {
  createGeminiPrivateClient,
  geminiTradingSettings,
  isGeminiPrivateError,
  type GeminiPrivateClient,
} from "@mandate/gemini/private";
import { type ExecutorContract, type ExecutorVenue, loadEnv, PolicyClient, WriteLane } from "@mandate/shared";
import { type ResolvedDeployment, resolvePolicyDeployment } from "@mandate/shared/node";
import {
  announceUntilAccepted,
  announceVenue,
  consoleContractDiscovery,
  consoleOrderJournal,
  consoleSettlementSink,
  devGeminiClient,
  executorHead,
  executorPolicyClient,
  executorReceiptPolling,
  executorTarget,
  geminiVenue,
  simulatedVenue,
  startExecutor,
  startExecutorFleet,
  venueDeployment,
  waitForExecutorRole,
  type Executor,
  type ExecutorTarget,
  type RecordSigner,
  type Venue,
} from "../src";
import { defaultExecutorPollMs, executorSettings } from "../src/executor-settings";

function fail(message: string): never {
  console.error(`[executor] ${message}`);
  process.exit(1);
}

loadEnv();

let settings: ReturnType<typeof executorSettings>;
// Which Gemini the checks, outcomes and (on Gemini) orders read: the rule the whole stack follows.
let marketData: MarketDataSource;
try {
  settings = executorSettings(process.env);
  marketData = marketDataSource(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { fillDelayMs, settleIntervalMs, consoleUrl, orderTtlMs } = settings;

let deployment: ResolvedDeployment;
let target: ExecutorTarget;
try {
  deployment = resolvePolicyDeployment();
  target = executorTarget(process.env, deployment);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
/** The RPC URL may carry a provider key: only its host is ever printed. */
const rpcHost = new URL(target.rpcUrl).host;
const redact = (text: string): string => text.replaceAll(target.rpcUrl, rpcHost);

const client = executorPolicyClient(target);
const pollingIntervalMs = settings.pollingIntervalMs ?? defaultExecutorPollMs(target.local);
/** One head poll for every contract served, and the endpoint's rate-limit gate. */
const shared = executorHead(target, client);
const wallet = client.walletClient;
if (wallet === undefined) fail("The executor's client has no wallet.");
// Narrowed once here: the functions below use it after the check above.
const signer = wallet;
const executorAddress = signer.account.address;
// Waits, rather than exiting into a restart loop, until the owner has made this key the executor.
await waitForExecutorRole({
  readExecutor: async () => (await client.getRoles()).executor,
  executor: executorAddress,
  policy: target.policy,
  log: (line) => {
    console.log(line);
  },
  redact,
});
const sign: RecordSigner = (hash) => wallet.signMessage({ account: wallet.account, message: { raw: hash } });
const chainId = client.publicClient.chain.id;
/** Every contract's writes go through this one lane: one key, one transaction at a time (#95). */
const lane = new WriteLane();

/** The venue for one contract: its own journal and announcement, the account the same for all. */
let venueFor: (
  policyClient: PolicyClient,
  deployBlock: bigint,
) => Promise<{ venue: Venue; announcement: ExecutorVenue }>;
let describeVenue: string;
if (settings.venue === "gemini") {
  let trading: GeminiPrivateClient;
  let publicClient: GeminiClient;
  let productionClient: GeminiClient;
  try {
    const gemini = geminiTradingSettings(process.env);
    if (gemini.environment === "production") {
      fail(
        target.local
          ? "Live trading is refused on the devchain: its owner and agent keys are public test keys, so " +
              "anyone could approve an order. Use GEMINI_ENV=sandbox."
          : "Live trading is refused on Arc testnet: this executor trades on Gemini's sandbox only. Use " +
              "GEMINI_ENV=sandbox.",
      );
    }
    if (gemini.credentials === null) {
      fail("EXECUTOR_VENUE=gemini needs GEMINI_API_KEY and GEMINI_API_SECRET. Run npm run gemini:doctor.");
    }
    trading = createGeminiPrivateClient({ environment: gemini.environment, credentials: gemini.credentials });
    // The sandbox lists other strikes than production, so the checks and outcomes read the environment
    // the orders go to: the stack's market data source, which follows GEMINI_ENV here and refuses a
    // GEMINI_API_URL naming another host (a loopback fake in tests is allowed). Fills the simulated venue
    // made before are listed and resolved on production, where it read them.
    publicClient = createMarketDataClient(marketData, { maxRetries: 1, timeoutMs: 8_000 });
    productionClient = createProductionClient(marketData, { maxRetries: 1, timeoutMs: 8_000 });
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
  const environment = trading.environment;
  venueFor = async (policyClient, deployBlock) => {
    // The deploy block's hash is part of every client order id, so a later chain that deploys a contract
    // at the same address never reuses the ids of this one's orders on the same Gemini account (#117). A
    // block that cannot be read yet throws: the fleet tries the contract again on its next look.
    const venueAt = await venueDeployment(policyClient, deployBlock);
    return {
      venue: geminiVenue({
        publicClient,
        productionClient,
        trading,
        journal: consoleOrderJournal({ consoleUrl, sign, deployment: { chainId, policy: venueAt.policy } }),
        deployment: venueAt,
        orderTtlMs,
        // One Gemini account serves every mandate's contract, so another's order could share the terms.
        matchByTerms: false,
      }),
      announcement: {
        kind: "executor-venue",
        version: 1,
        chainId,
        policy: venueAt.policy,
        venue: "gemini",
        environment,
        announcedAt: new Date().toISOString(),
      },
    };
  };
  describeVenue =
    `GEMINI ${environment.toUpperCase()} executor: places approved orders on Gemini's sandbox (test funds), ` +
    `cancels what is unfilled after ${String(Math.round(orderTtlMs / 60_000))} min`;
} else {
  const gemini = devGeminiClient();
  // The simulated venue places nothing, so it needs no client order id and no deploy block.
  venueFor = (policyClient) =>
    Promise.resolve({
      venue: simulatedVenue(gemini),
      announcement: {
        kind: "executor-venue",
        version: 1,
        chainId,
        policy: policyClient.address.toLowerCase() as `0x${string}`,
        venue: "simulated",
        environment: null,
        announcedAt: new Date().toISOString(),
      },
    });
  describeVenue = `SIMULATED executor${target.local ? " (dev only)" : ""}: places nothing, fills after ${String(fillDelayMs)} ms`;
}

console.log(
  `[executor] ${describeVenue}; on ${target.network} as ${executorAddress}; serving ${target.policy} and every mandate's contract that names this ` +
    `executor (listed by the console at ${consoleUrl}), polling every ${String(pollingIntervalMs)} ms; ` +
    `checks every approved intent against Gemini's ${marketData.environment} first (${marketData.settings}); ` +
    `settles expired positions every ${String(settleIntervalMs / 1_000)} s into the console`,
);

/**
 * Tells the console which venue fills this contract's orders (its Sandbox badge), and logs what the console
 * did with it: every failed attempt with its wait, then the announcement stored or found in force. A
 * console that reads another Gemini refuses it (environment_mismatch), and the executor stops there.
 */
function announce(announcement: ExecutorVenue): Promise<void> {
  return announceUntilAccepted({
    announce: () => announceVenue({ consoleUrl, sign }, announcement),
    policy: announcement.policy,
    log: (line) => {
      console.log(line);
    },
  }).then(
    () => undefined,
    (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
  );
}

/** Serves one contract, once its own `executor()` is this key: the console's listing is not trusted. */
async function serve(contract: ExecutorContract): Promise<Executor | { refused: string }> {
  const policy = contract.policy.toLowerCase() as `0x${string}`;
  const policyClient = new PolicyClient({
    address: policy,
    publicClient: client.publicClient,
    walletClient: signer,
    lane,
    ...executorReceiptPolling(target),
  });
  const named = (await policyClient.getRoles()).executor;
  if (named.toLowerCase() !== executorAddress.toLowerCase()) {
    return { refused: `its executor is ${named}, not this one` };
  }
  const { venue, announcement } = await venueFor(policyClient, BigInt(contract.deployBlock));
  const announced = announce(announcement);
  // On Gemini, nothing is traded for a contract before the console has agreed to its venue.
  if (settings.venue === "gemini") await announced;
  return startExecutor({
    client: policyClient,
    venue,
    settlements: consoleSettlementSink({ consoleUrl }),
    fromBlock: BigInt(contract.deployBlock),
    fillDelayMs,
    settleIntervalMs,
    pollingIntervalMs,
    head: shared.head,
    gate: shared.gate,
  });
}

const discover = consoleContractDiscovery({
  consoleUrl,
  chainId,
  signMessage: (message) => wallet.signMessage({ account: wallet.account, message }),
});
const own: ExecutorContract = {
  chainId,
  policy: target.policy.toLowerCase(),
  deployBlock: Number(target.deployBlock),
};
// The server's own contract is served at once, whether or not the console answers yet.
const fleet = startExecutorFleet({
  always: [own],
  discover,
  start: serve,
  intervalMs: settings.discoveryIntervalMs,
});
await fleet.refresh();
if (!fleet.serving().includes(`${String(chainId)}:${own.policy}`)) {
  fail(`Could not serve ${own.policy}; see above.`);
}

process.on("SIGINT", () => {
  fleet.stop();
  process.exit(0);
});
