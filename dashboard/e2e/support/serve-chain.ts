/**
 * `tsx e2e/support/serve-chain.ts --suite smoke --port 8645 [--seed demo]`: starts anvil, deploys the
 * production Policy contract, optionally seeds the demo history, writes the suite's deployment file,
 * prints "e2e chain ready" and runs until stopped. Playwright starts it before the console.
 */
import { parseArgs } from "node:util";

import { freshSuiteDir, seedDemo, startTestChain } from "./chain";

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "smoke" },
    port: { type: "string", default: "8645" },
    seed: { type: "string", default: "none" },
  },
});

const paths = freshSuiteDir(values.suite);
const chain = await startTestChain({ port: Number(values.port), deploymentFile: paths.deploymentFile });
if (values.seed === "demo") await seedDemo(chain);
console.log(`e2e chain ready: ${chain.anvil.rpcUrl}, Policy ${chain.address}, ${paths.deploymentFile}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await chain.anvil.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
