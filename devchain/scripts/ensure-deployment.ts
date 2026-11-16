/**
 * `npm run ensure-deployment -w @mandate/devchain`: DEPLOY ONCE ON A LONG-LIVED DEVCHAIN, DEMO ONLY.
 *
 * The hosted demo chain (`deploy/compose.demo.yml`) runs this once per start, after anvil and before
 * everything that reads the contract. It reuses the Policy contract recorded in the deployment file while
 * that contract is still on the chain, and otherwise deploys a fresh one with the demo rules and rewrites
 * the file (see `ensureDeployment`). It needs compiled contracts (the image compiles them at build time;
 * locally, `npm run dev:chain` or the test setup does).
 *
 * Environment:
 *   DEVCHAIN_RPC_URL        the chain, as the other processes reach it (required)
 *   POLICY_DEPLOYMENT_FILE  the deployment file to reuse and write (required)
 *   DEVCHAIN_CONTRACT       production or reference (default reference, like `npm run dev:stack`)
 */
import { isPolicyContractKind, POLICY_CONTRACTS, ensureDeployment } from "../src";

function fail(message: string): never {
  console.error(`ensure-deployment: ${message}`);
  process.exit(1);
}

const rpcUrl = process.env.DEVCHAIN_RPC_URL?.trim();
if (!rpcUrl || !URL.canParse(rpcUrl)) fail("DEVCHAIN_RPC_URL must be the chain's http(s) URL.");
const path = process.env.POLICY_DEPLOYMENT_FILE?.trim();
if (!path) fail("POLICY_DEPLOYMENT_FILE must name the deployment file to reuse or write.");
const contract = process.env.DEVCHAIN_CONTRACT?.trim() || "reference";
if (!isPolicyContractKind(contract)) {
  fail(`DEVCHAIN_CONTRACT must be one of ${POLICY_CONTRACTS.join(", ")}, got "${contract}".`);
}

try {
  const result = await ensureDeployment({ rpcUrl, contract, path });
  const { record } = result;
  const what = `${record.contract} Policy contract ${record.address} (block ${String(record.blockNumber)})`;
  console.log(
    result.action === "reused"
      ? `ensure-deployment: reusing the ${what}.`
      : `ensure-deployment: deployed the ${what} with the demo rules, because ${result.reason}.`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
