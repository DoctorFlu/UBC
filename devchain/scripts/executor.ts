/**
 * `npm run dev:executor`: SIMULATED EXECUTOR, DEVELOPMENT ONLY.
 *
 * Watches the devchain Policy contract for `IntentApproved` and, after a short delay, records a full fill
 * with zero profit and loss. It never places an order. Before acting it checks the intent the way a real
 * executor must (see `src/executor.ts`): a market Gemini does not list, a category Gemini disagrees with,
 * an outcome other than YES or NO, or a limit price outside 1 to 99 is refused and recorded as not
 * filled. It reads Gemini's public market data (or `GEMINI_API_URL`) for that check; when Gemini cannot be
 * reached it waits and tries again rather than fill blindly.
 *
 * Once a filled position's market has expired and Gemini has published its outcome, it records what the
 * position paid in the console (`CONSOLE_URL`), signed with the executor key (issue #92; see
 * docs/order-lifecycle.md). It refuses to run against anything but the local devchain.
 */
import { resolvePolicyDeployment } from "@mandate/shared/node";
import {
  consoleSettlementSink,
  devGeminiClient,
  devPolicyClient,
  simulatedVenue,
  startExecutor,
} from "../src";
import { executorSettings } from "../src/executor-settings";

const { fillDelayMs, pollingIntervalMs, settleIntervalMs, consoleUrl } = executorSettings(process.env);

const deployment = resolvePolicyDeployment();
if (deployment.source !== "devchain") {
  console.error("The simulated executor only runs against the local devchain. Unset POLICY_ADDRESS.");
  process.exit(1);
}

const client = devPolicyClient(deployment.rpcUrl, deployment.address, "executor");
const roles = await client.getRoles();
if (roles.executor.toLowerCase() !== client.account?.address.toLowerCase()) {
  console.error(`This contract's executor is ${roles.executor}, not the devchain executor account.`);
  process.exit(1);
}

console.log(
  `[simulated-executor] SIMULATED executor (dev only) watching ${deployment.address}, fill delay ${fillDelayMs} ms, ` +
    `polling every ${String(pollingIntervalMs ?? 1_000)} ms; ` +
    "checks every approved intent against Gemini before filling; " +
    `settles expired positions every ${String(settleIntervalMs / 1_000)} s into the console at ${consoleUrl}`,
);
const executor = startExecutor({
  client,
  venue: simulatedVenue(devGeminiClient()),
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
