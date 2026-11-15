/**
 * `npm run dev:stack [-- options]`: THE WHOLE PRODUCT ON ONE MACHINE, DEVELOPMENT ONLY.
 *
 * Starts, in order, and wires together:
 *   1. anvil with a freshly deployed Policy contract (the local devchain),
 *   2. the paid signal API,
 *   3. the console,
 *   4. the MCP server, acting as the devchain agent account,
 *   5. the simulated executor, which fills approved intents.
 *
 * Everything the processes must agree on (contract address, RPC, the console's service token, the
 * agent key) is passed to them in their environment, so nothing has to be edited in `.env` to try the
 * full flow. The agent key is anvil's public test key and the RPC is loopback, so no trade can reach a
 * shared network. The service token is generated for this run and never printed.
 *
 * Options:
 *   --contract reference|production  Which Policy contract to deploy (default reference: it has the
 *                                    requested extensions, so reasons are sealed onchain).
 *   --blank                          Deploy without rules, to rehearse creating the first mandate.
 *   --prod                           Build the console and serve the build instead of `next dev`.
 *   --no-executor                    Do not start the simulated executor.
 *   --console-port <port>            Console port (default 3000).
 *   --mcp-public-url <url>           Public address of the MCP server (the tunnel), shown on the console's
 *                                    Setup page. Defaults to MCP_PUBLIC_URL.
 *
 * The chain and the console's store are new on every run. Ctrl+C stops everything.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONSOLE_AGENT_API_BASE, CONSOLE_AGENT_ROUTES, formatCents, loadEnv } from "@mandate/shared";
import { localDeploymentPath } from "@mandate/shared/node";
import {
  type AnvilInstance,
  buildContracts,
  DEMO_POLICY,
  deployPolicy,
  deploymentRecord,
  devPrivateKey,
  isPolicyContractKind,
  POLICY_CONTRACTS,
  type PolicyContractKind,
  startAnvil,
  startDevchain,
  writeDeploymentFile,
} from "../src";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHAIN_PORT = 8545;
const STARTUP_TIMEOUT_MS = 240_000;

const { values } = parseArgs({
  options: {
    contract: { type: "string", default: "reference" },
    blank: { type: "boolean", default: false },
    prod: { type: "boolean", default: false },
    "no-executor": { type: "boolean", default: false },
    "console-port": { type: "string", default: "3000" },
    "mcp-public-url": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`dev:stack: ${message}`);
  process.exit(1);
}

if (!isPolicyContractKind(values.contract)) {
  fail(`--contract must be one of ${POLICY_CONTRACTS.join(", ")}, got "${values.contract}"`);
}
const contract: PolicyContractKind = values.contract;
const consolePort = Number(values["console-port"]);
if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65_535) {
  fail("--console-port must be a TCP port");
}

// The same file the MCP server and the signal API read, so the ports below are the ones they will use.
loadEnv();
const mcpPort = Number(process.env.MCP_PORT ?? 8787);
const signalsPort = Number(process.env.SIGNALS_PORT ?? 8788);
if (!process.env.MCP_AUTH_TOKEN?.trim()) {
  fail("MCP_AUTH_TOKEN is not set. Run `npm run mcp:token` once, then start the stack again.");
}

const mcpPublicUrl = values["mcp-public-url"]?.trim() || process.env.MCP_PUBLIC_URL?.trim() || undefined;
if (mcpPublicUrl !== undefined && !URL.canParse(mcpPublicUrl)) fail("--mcp-public-url must be a URL");

const consoleUrl = `http://localhost:${String(consolePort)}`;
const mcpUrl = `http://127.0.0.1:${String(mcpPort)}`;
const signalsUrl = `http://localhost:${String(signalsPort)}`;

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1_000, () => {
      done(false);
    });
    socket.once("connect", () => {
      done(true);
    });
    socket.once("error", () => {
      done(false);
    });
  });
}

const ports = [
  { name: "the devchain", port: CHAIN_PORT },
  { name: "the signal API", port: signalsPort },
  { name: "the console", port: consolePort },
  { name: "the MCP server", port: mcpPort },
];
for (const { name, port } of ports) {
  if (await portInUse(port)) {
    fail(
      `port ${String(port)} (${name}) is already in use. Stop the process that holds it; the stack starts its own.`,
    );
  }
}

// ------------------------------------------------------------------ processes

interface Service {
  name: string;
  child: ChildProcess;
}
const services: Service[] = [];
let anvil: AnvilInstance | null = null;
let stopping = false;

/** Children load `.env` themselves; these values win because variables already set are kept. */
function start(name: string, args: string[], env: Record<string, string>): Service {
  const child = spawn("npm", args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stopping it also stops what npm started (tsx, next, node).
    detached: true,
  });
  const label = `[${name}]`.padEnd(11);
  const forward = (stream: NodeJS.ReadableStream | null): void => {
    let rest = "";
    stream?.on("data", (chunk: Buffer) => {
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${label} ${line}\n`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`dev:stack: ${name} stopped unexpectedly (${signal ?? `code ${String(code)}`}).`);
    void shutdown(1);
  });
  const service = { name, child };
  services.push(service);
  return service;
}

function stopService({ child }: Service): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    const pid = child.pid;
    const force = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      clearTimeout(force);
      resolve();
    }
  });
}

const deploymentPath = localDeploymentPath();

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("\ndev:stack: stopping...");
  await Promise.all([...services].reverse().map(stopService));
  // The chain's state dies with anvil, so a leftover file would point other packages at nothing.
  if (existsSync(deploymentPath)) unlinkSync(deploymentPath);
  await anvil?.stop();
  console.log("dev:stack: stopped.");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

async function waitFor(name: string, url: string, init?: RequestInit): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no answer";
  while (Date.now() < deadline) {
    if (stopping) return;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      await response.arrayBuffer();
      if (response.ok) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} was not ready after ${String(STARTUP_TIMEOUT_MS / 1_000)} s (${last})`);
}

// ------------------------------------------------------------------ start-up

async function main(): Promise<void> {
  console.log("dev:stack: compiling the Policy contracts with forge...");
  buildContracts();

  console.log(`dev:stack: starting anvil on 127.0.0.1:${String(CHAIN_PORT)}...`);
  let deployment;
  if (values.blank) {
    anvil = await startAnvil({ port: CHAIN_PORT });
    deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract });
  } else {
    const chain = await startDevchain({ contract, port: CHAIN_PORT });
    anvil = chain.anvil;
    deployment = chain.deployment;
  }
  anvil.process.once("exit", () => {
    if (stopping) return;
    console.error("dev:stack: anvil stopped unexpectedly.");
    void shutdown(1);
  });
  const record = writeDeploymentFile(deploymentRecord(anvil.rpcUrl, deployment), deploymentPath);

  // A new chain deploys to the same address, so an old event store would describe a chain that is gone.
  const dataDir = join(ROOT, "dashboard", ".data", "stack");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  // Shared by the console and the MCP server for this run only. Never printed.
  const serviceToken = randomBytes(32).toString("base64url");
  // Empty values beat whatever `.env` configures: every process must use this run's chain.
  const localChain = { POLICY_ADDRESS: "", POLICY_DEPLOY_BLOCK: "", POLICY_DEPLOYMENT_FILE: deploymentPath };

  start("signals", ["run", "start", "-w", "@mandate/signals"], {});

  const consoleEnv = {
    ...localChain,
    NEXT_PUBLIC_DEV_SIGNER: "1",
    CONSOLE_EVENT_SOURCE: "rpc",
    CONSOLE_DATA_DIR: dataDir,
    CONSOLE_SERVICE_TOKEN: serviceToken,
    CONSOLE_URL: consoleUrl,
    ...(mcpPublicUrl === undefined ? {} : { MCP_PUBLIC_URL: mcpPublicUrl }),
  };
  const next = (command: string): string[] => [
    "exec",
    "-w",
    "@mandate/dashboard",
    "--",
    "next",
    command,
    "--port",
    String(consolePort),
  ];
  if (values.prod) {
    console.log("dev:stack: building the console (about a minute)...");
    const build = spawn("npm", ["run", "build", "-w", "@mandate/dashboard"], {
      cwd: ROOT,
      env: { ...process.env, ...consoleEnv },
      stdio: "inherit",
    });
    const code = await new Promise<number | null>((resolve) => build.once("exit", resolve));
    if (code !== 0) throw new Error(`the console build failed with code ${String(code)}`);
  }
  start("console", next(values.prod ? "start" : "dev"), consoleEnv);

  start("mcp", ["run", "start:mcp", "-w", "@mandate/agent"], {
    // Anvil's public test key for the agent role. It can only propose trades on the local chain.
    AGENT_PRIVATE_KEY: devPrivateKey("agent"),
    ARC_RPC_URL: record.rpcUrl,
    POLICY_ADDRESS: record.address,
    POLICY_DEPLOY_BLOCK: String(record.blockNumber),
    CONSOLE_URL: consoleUrl,
    CONSOLE_SERVICE_TOKEN: serviceToken,
    SIGNALS_URL: signalsUrl,
  });

  if (!values["no-executor"]) {
    start("executor", ["run", "executor", "-w", "@mandate/devchain"], localChain);
  }

  const asAgent = { headers: { authorization: `Bearer ${serviceToken}` } };
  await Promise.all([
    waitFor("the signal API", `${signalsUrl}/health`),
    waitFor("the MCP server", `${mcpUrl}/health`),
    // `next dev` compiles a route on its first request; do that now so the agent's first calls are fast.
    waitFor("the console", `${consoleUrl}/api/console/snapshot`).then(() =>
      Promise.all([
        waitFor("the console", `${consoleUrl}/`),
        waitFor("the console's agent API", `${consoleUrl}${CONSOLE_AGENT_ROUTES.holdings}`, asAgent),
      ]),
    ),
  ]);
  if (stopping) return;

  const rules = values.blank
    ? "none yet: create the mandate in the console"
    : `budget ${formatCents(DEMO_POLICY.budgetCents)}, max trade ${formatCents(DEMO_POLICY.maxTradeCents)}, ` +
      `approval above ${formatCents(DEMO_POLICY.approvalAboveCents)}, daily loss ${formatCents(DEMO_POLICY.dailyLossCents)}`;
  const reach =
    mcpPublicUrl === undefined ? "expose it with `npm run dev:tunnel`" : `public at ${mcpPublicUrl}`;
  console.log(`
Mandate local stack is running (development only).
  Console     ${consoleUrl}  (owner signs with the test signer, anvil account 0)
  MCP server  ${mcpUrl}/mcp  (${reach})
  Signal API  ${signalsUrl}
  Chain       ${record.rpcUrl}  Policy ${record.address} (${record.contract})
  Agent       ${record.agent}  (anvil account 1)
  Executor    ${values["no-executor"] ? "not started" : "simulated: fills approved intents"}
  Agent API   ${consoleUrl}${CONSOLE_AGENT_API_BASE}
  Rules       ${rules}

Next: open the console, enter a holding under Hedge, then ask the agent to protect it.
Press Ctrl+C to stop everything.`);
}

try {
  await main();
} catch (error) {
  console.error(`dev:stack: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
