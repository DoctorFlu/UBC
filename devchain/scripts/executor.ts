/**
 * `npm run dev:executor`: SIMULATED EXECUTOR, DEVELOPMENT ONLY.
 *
 * Watches the devchain Policy contract for `IntentApproved` and, after a short delay, records a full fill
 * with zero profit and loss. It never talks to Gemini. It exists so the console and agent can show fills
 * before the real executor is built. It refuses to run against anything but the local devchain.
 */
import { formatCents, type PolicyEventOf } from "@mandate/shared";
import { resolvePolicyDeployment } from "@mandate/shared/node";
import { devPolicyClient } from "../src";

const delayMs = Number(process.env.SIM_EXECUTOR_DELAY_MS ?? 1_500);

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

const inFlight = new Set<number>();

async function fill(event: PolicyEventOf<"IntentApproved">): Promise<void> {
  if (inFlight.has(event.intentId)) return;
  inFlight.add(event.intentId);
  try {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const intent = await client.getIntent(event.intentId);
    if (intent?.status !== "approved") return; // already recorded, for example after a restart
    const { txHash } = await client.recordResult({
      intentId: event.intentId,
      filled: true,
      filledCents: event.amountCents,
      pnlCents: 0,
    });
    console.log(
      `[sim-executor] intent #${event.intentId} ${event.isBuy ? "buy" : "sell"} ${event.outcome} ` +
        `${event.market} ${formatCents(event.amountCents)} at ${event.limitPrice}c: simulated full fill (${txHash})`,
    );
  } catch (error) {
    console.error(`[sim-executor] intent #${event.intentId}:`, error);
  } finally {
    inFlight.delete(event.intentId);
  }
}

console.log(
  `[sim-executor] SIMULATED executor (dev only) watching ${deployment.address}, fill delay ${delayMs} ms`,
);
const stop = client.watchEvents({
  fromBlock: deployment.fromBlock ?? 0n,
  onEvents: (events) => {
    for (const event of events) {
      if (event.type === "IntentApproved") void fill(event);
    }
  },
  onError: (error) => {
    console.error("[sim-executor] polling failed:", error instanceof Error ? error.message : error);
  },
});

process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
