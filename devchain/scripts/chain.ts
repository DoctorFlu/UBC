/**
 * `npm run dev:chain`: starts anvil with Arc testnet's chain id, deploys the reference Policy contract,
 * seeds the demo policy and writes devchain/deployments/local.json. Runs until Ctrl+C.
 */
import { existsSync, unlinkSync } from "node:fs";
import { categoryLabel, categoriesFromMask, formatCents } from "@mandate/shared";
import { LOCAL_DEPLOYMENT_PATH } from "@mandate/shared/node";
import {
  buildContracts,
  DEMO_POLICY,
  deploymentRecord,
  deployPolicy,
  devPolicyClient,
  startAnvil,
  writeDeploymentFile,
} from "../src";

const port = Number(process.env.DEVCHAIN_PORT ?? 8545);

console.log("Compiling contracts/PolicyReference.sol with forge...");
buildContracts();

console.log(`Starting anvil on 127.0.0.1:${port}...`);
const anvil = await startAnvil({ port });

const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl });
const owner = devPolicyClient(anvil.rpcUrl, deployment.address, "owner");
await owner.setPolicy(DEMO_POLICY);
const record = writeDeploymentFile(deploymentRecord(anvil.rpcUrl, deployment));

const categories = categoriesFromMask(DEMO_POLICY.allowedCategories).map(categoryLabel).join(", ");
console.log(`
Mandate devchain is running (development only).
  RPC        ${record.rpcUrl} (chain id ${record.chainId})
  Policy     ${record.address} (block ${record.blockNumber})
  Owner      ${record.owner}  (anvil account 0)
  Agent      ${record.agent}  (anvil account 1)
  Executor   ${record.executor}  (anvil account 2)
  Written to ${LOCAL_DEPLOYMENT_PATH}

Demo policy: budget ${formatCents(DEMO_POLICY.budgetCents)}, max trade ${formatCents(DEMO_POLICY.maxTradeCents)}, \
categories ${categories}, approval above ${formatCents(DEMO_POLICY.approvalAboveCents)}, \
daily loss ${formatCents(DEMO_POLICY.dailyLossCents)}.

Next: \`npm run dev:executor\` in another terminal, then \`npm run dev:propose -- --amount 10\`.
Press Ctrl+C to stop.`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // The chain's state dies with anvil, so a leftover file would point other packages at nothing.
  if (existsSync(LOCAL_DEPLOYMENT_PATH)) unlinkSync(LOCAL_DEPLOYMENT_PATH);
  await anvil.stop();
  console.log("\nDevchain stopped.");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
anvil.process.once("exit", (code) => {
  if (stopping) return;
  console.error(`anvil exited unexpectedly with code ${String(code)}`);
  if (existsSync(LOCAL_DEPLOYMENT_PATH)) unlinkSync(LOCAL_DEPLOYMENT_PATH);
  process.exit(1);
});
