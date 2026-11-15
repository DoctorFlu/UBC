/**
 * `npm run dev:chain [-- --contract production|reference]`: starts anvil with Arc testnet's chain id,
 * deploys a Policy contract, seeds the demo rules and writes devchain/deployments/local.json.
 * Runs until Ctrl+C.
 *
 *   --contract production  `contracts/src/Policy.sol` as is (default): what will run on Arc.
 *   --contract reference   `devchain/contracts/PolicyReference.sol`: the same rules plus the requested
 *                          extensions (IntentProposed, contextHash, previewTrade).
 */
import { existsSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { categoryLabel, categoriesFromMask, formatCents } from "@mandate/shared";
import { LOCAL_DEPLOYMENT_PATH } from "@mandate/shared/node";
import {
  buildContracts,
  DEMO_POLICY,
  deploymentRecord,
  isPolicyContractKind,
  POLICY_CONTRACTS,
  startDevchain,
  writeDeploymentFile,
} from "../src";

const { values } = parseArgs({
  options: { contract: { type: "string", default: process.env.DEVCHAIN_CONTRACT ?? "production" } },
});
const contract = values.contract;
if (!isPolicyContractKind(contract)) {
  console.error(`--contract must be one of ${POLICY_CONTRACTS.join(", ")}, got "${contract}"`);
  process.exit(1);
}
const port = Number(process.env.DEVCHAIN_PORT ?? 8545);

console.log("Compiling contracts/src/Policy.sol and devchain/contracts/PolicyReference.sol with forge...");
buildContracts();

console.log(`Starting anvil on 127.0.0.1:${port}...`);
const { anvil, deployment, capabilities } = await startDevchain({ contract, port });
const record = writeDeploymentFile(deploymentRecord(anvil.rpcUrl, deployment));

const categories = categoriesFromMask(DEMO_POLICY.allowedCategories).map(categoryLabel).join(", ");
const extensions =
  capabilities.previewTrade || capabilities.proposeWithContext
    ? "IntentProposed, contextHash, previewTrade"
    : "none (base features only)";
console.log(`
Mandate devchain is running (development only).
  RPC        ${record.rpcUrl} (chain id ${record.chainId})
  Policy     ${record.address} (block ${record.blockNumber})
  Contract   ${record.contract}, extensions: ${extensions}
  User       ${record.user}  (anvil account 0)
  Agent      ${record.agent}  (anvil account 1)
  Executor   ${record.executor}  (anvil account 2)
  Written to ${LOCAL_DEPLOYMENT_PATH}

Demo rules: budget ${formatCents(DEMO_POLICY.budgetCents)}, max trade ${formatCents(DEMO_POLICY.maxTradeCents)}, \
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
