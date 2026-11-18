/**
 * `npm run arc:deploy -- --owner 0x... [--resume 0x...] [--dry-run] [--fork] [--new]`: deploys our own
 * instance of the Policy contract on Arc testnet, as `contracts/script/Deploy.s.sol` does, then runs the
 * doctor against it (see `src/arc-deploy.ts`).
 *
 * The keys come from the env file the process loads (`ENV_FILE`), never from the command line, and are
 * never printed. `--dry-run` runs everything on a throwaway local fork of Arc testnet and sends nothing to
 * Arc. `--fork` accepts a loopback `ARC_RPC_URL`: a local fork that the operator started.
 *
 * Exit code: 0 deployed (or nothing missing) and the doctor says READY, 1 refused or not ready, 2 failed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ARC_TESTNET, loadEnv } from "@mandate/shared";
import { isAddress, type Abi, type Hex } from "viem";
import { arcDoctor } from "../src/arc-doctor";
import { ArcDeployRefused, arcDeploy, checkDeployInputs, type PolicyBuild } from "../src/arc-deploy";
import { startAnvil, type AnvilInstance } from "../src/anvil";
import { PRODUCTION_OUT_DIR, buildContracts } from "../src/foundry";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    resume: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    fork: { type: "boolean", default: false },
    new: { type: "boolean", default: false },
  },
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
}

/** Set once the RPC is known, so an error message never shows a provider URL (it may carry a key). */
let redactedUrl = "";

const say = (line: string) => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  loadEnv();
  const configured = process.env.ARC_RPC_URL?.trim() || ARC_TESTNET.rpcUrl;
  redactedUrl = configured;
  const dryRun = values["dry-run"];
  const inputs = checkDeployInputs({
    env: process.env,
    owner: values.owner,
    rpcUrl: configured,
    fork: values.fork,
  });
  if (values.resume !== undefined && !isAddress(values.resume)) {
    throw new ArcDeployRefused(`--resume ${values.resume} is not an address.`);
  }

  buildContracts();
  const json = JSON.parse(readFileSync(join(PRODUCTION_OUT_DIR, "Policy.sol", "Policy.json"), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
    deployedBytecode: { object: Hex };
  };
  const build: PolicyBuild = {
    abi: json.abi,
    bytecode: json.bytecode.object,
    deployedBytecode: json.deployedBytecode.object,
  };

  // A dry run forks the configured chain when it is a local fork, else Arc's public RPC, never a provider
  // URL: anvil's arguments would show its key.
  let anvil: AnvilInstance | null = null;
  let rpcUrl = configured;
  if (dryRun) {
    const source = values.fork ? configured : ARC_TESTNET.rpcUrl;
    say(`DRY RUN: on a throwaway local fork of ${hostOf(source)}; nothing is sent to Arc.`);
    anvil = await startAnvil({ port: 0, fork: { rpcUrl: source } });
    rpcUrl = anvil.rpcUrl;
  } else {
    say(`Arc deploy: sends to ${hostOf(rpcUrl)}${values.fork ? " (a local fork)" : ""}. It prints no key.`);
  }
  try {
    const result = await arcDeploy({
      ...inputs,
      rpcUrl,
      build,
      say,
      resume: values.resume,
      allowAnother: values.new,
      pollingMs: dryRun || values.fork ? 100 : 500,
    });
    say("");
    say("The doctor, against the same chain:");
    say("");
    const status = await arcDoctor({
      env: {
        ...process.env,
        ARC_RPC_URL: rpcUrl,
        POLICY_ADDRESS: result.address,
        POLICY_DEPLOY_BLOCK: result.deployBlock.toString(),
      },
      say: (line) => {
        say(`   ${line}`);
      },
      owner: inputs.owner,
      // A local chain is measured on a fork of itself; Arc on a fork of its public RPC, as always.
      ...(anvil !== null || values.fork ? { forkRpcUrl: rpcUrl } : {}),
    });
    if (dryRun) say("\nDRY RUN: the fork is discarded; nothing was sent to Arc.");
    return status === 0 ? 0 : 1;
  } finally {
    await anvil?.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ArcDeployRefused) {
      say(`REFUSED: ${error.message}`);
      process.exit(1);
    }
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
    say(`FAILED: ${redactedUrl === "" ? message : message.replaceAll(redactedUrl, hostOf(redactedUrl))}`);
    process.exit(2);
  },
);
