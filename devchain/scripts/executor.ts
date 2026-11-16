/**
 * `npm run dev:executor`: SIMULATED EXECUTOR, DEVELOPMENT ONLY.
 *
 * Watches the devchain Policy contract for `IntentApproved` and, after a short delay, records a full fill
 * with zero profit and loss. It never places an order. Before acting it checks the intent the way a real
 * executor must (see `src/executor.ts`): a market Gemini does not list, a category Gemini disagrees with,
 * an outcome other than YES or NO, or a limit price outside 1 to 99 is refused and recorded as not
 * filled. It reads Gemini's public market data (or `GEMINI_API_URL`) for that check; when Gemini cannot be
 * reached it waits and tries again rather than fill blindly. It refuses to run against anything but the
 * local devchain.
 */
import { resolvePolicyDeployment } from "@mandate/shared/node";
import { devGeminiClient, devPolicyClient, geminiVenue, startSimulatedExecutor } from "../src";

const fillDelayMs = Number(process.env.SIM_EXECUTOR_DELAY_MS ?? 1_500);

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
  `[sim-executor] SIMULATED executor (dev only) watching ${deployment.address}, fill delay ${fillDelayMs} ms; ` +
    "checks every approved intent against Gemini before filling",
);
const executor = startSimulatedExecutor({
  client,
  venue: geminiVenue(devGeminiClient()),
  fromBlock: deployment.fromBlock ?? 0n,
  fillDelayMs,
});

process.on("SIGINT", () => {
  executor.stop();
  process.exit(0);
});
