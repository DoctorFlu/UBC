/**
 * `npm run mcp:e2e [-- --contract production|reference|both]`: the whole agent flow end to end,
 * the way Grok Bot runs it, in one command.
 *
 * For each contract it starts a local chain (anvil, a fresh Policy contract with the demo rules),
 * an in-memory console on a free port, and the real MCP server as a child process on another
 * free port (never 8787, 8788 or 3000). It then drives the server over HTTP with the official MCP
 * SDK client, opening a fresh session for every tool call as Grok Bot does, against live public
 * Gemini market data. It checks the three demo cases (approved, blocked with the contract's
 * reason, waiting for the owner), the sealed decision contexts, and that nothing secret reaches
 * the server's logs.
 *
 * Every key here is a public anvil test key or a random token made for this run; the token is
 * written to a temporary env file (mode 600) and never printed or passed on a command line.
 * `.env` is not read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPublicClient, http } from "viem";
import {
  buildContracts,
  devPrivateKey,
  isPolicyContractKind,
  startDevchain,
  type PolicyContractKind,
} from "@mandate/devchain";
import { devchain, policyAbi, verifyContext } from "@mandate/shared";
import { ENV_KEYS } from "../src/config";
import { createFakeConsole, type FakeConsole } from "../testing/fake-console";

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const RESERVED_PORTS = new Set([8787, 8788, 3000]);

type Structured = Record<string, unknown>;
interface CallResult {
  isError?: boolean;
  structuredContent?: Structured;
  content?: { type: string; text?: string }[];
}

let failures = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    process.stdout.write(`    ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`    FAIL ${label}\n`);
  }
}

const field = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });
    });
    if (port !== 0 && !RESERVED_PORTS.has(port)) return port;
  }
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Starts the real MCP server (`src/main.ts`) with only the variables of this run. */
async function startMcpServer(
  env: Record<string, string>,
): Promise<{ child: ChildProcess; logs: string[]; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-e2e-"));
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  // Inherited variables win over the env file, so drop every one the server reads.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !(ENV_KEYS as readonly string[]).includes(key) && key !== "ENV_FILE",
    ),
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: AGENT_DIR,
    env: { ...inherited, ENV_FILE: envFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const collect = (chunk: Buffer) => {
    logs.push(
      ...chunk
        .toString()
        .split("\n")
        .filter((line) => line !== ""),
    );
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const base = `http://127.0.0.1:${env["MCP_PORT"] ?? ""}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`the MCP server exited:\n${logs.slice(-20).join("\n")}`);
      try {
        if ((await fetch(`${base}/health`)).ok) return { child, logs, base };
      } catch {
        // not listening yet
      }
      await sleep(200);
    }
    throw new Error("the MCP server did not answer /health within 20 s");
  } finally {
    // The server has read the file by the time it answers; remove it either way.
    unlinkSync(envFile);
    rmdirSync(dir);
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** One tool call in a fresh MCP session, as Grok Bot makes every call. */
async function call(base: string, token: string, name: string, args: Structured = {}): Promise<CallResult> {
  const client = new Client({ name: "mandate-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallResult;
    const text = (result.content ?? []).map((block) => block.text ?? "").join(" ");
    const status = field(result.structuredContent, "status");
    const label = result.isError === true ? "ERROR" : typeof status === "string" ? status : "-";
    process.stdout.write(
      `  ${name} -> ${label}\n    ${text.length > 400 ? `${text.slice(0, 397)}...` : text}\n`,
    );
    return result;
  } finally {
    await client.close();
  }
}

async function runOne(contract: PolicyContractKind): Promise<void> {
  const extended = contract === "reference";
  process.stdout.write(
    `\n=== ${contract} contract ${extended ? "(with previewTrade and contextHash)" : "(Policy.sol as is)"}\n`,
  );

  const chain = await startDevchain({ contract, port: await freePort() });
  const publicClient = createPublicClient({
    chain: { ...devchain, rpcUrls: { default: { http: [chain.rpcUrl] } } },
    transport: http(chain.rpcUrl),
  });
  const consoleToken = randomBytes(24).toString("base64url");
  const consolePort = await freePort();
  const fake: FakeConsole = createFakeConsole({
    token: consoleToken,
    publicUrl: `http://127.0.0.1:${consolePort}`,
    holdings: [{ asset: "BTC", quantity: "0.05", note: "Long-term holding" }],
    isContractAgent: async (address) => {
      const agent: unknown = await publicClient.readContract({
        address: chain.deployment.address,
        abi: policyAbi,
        functionName: "agent",
      });
      return String(agent).toLowerCase() === address.toLowerCase();
    },
  });
  const consoleServer = serve({ fetch: fake.fetch, port: consolePort, hostname: "127.0.0.1" });

  const mcpToken = randomBytes(32).toString("base64url");
  const agentKey = devPrivateKey("agent");
  const server = await startMcpServer({
    MCP_AUTH_TOKEN: mcpToken,
    MCP_PORT: String(await freePort()),
    MCP_HOST: "127.0.0.1",
    MCP_LOG_LEVEL: "info",
    ARC_RPC_URL: chain.rpcUrl,
    POLICY_ADDRESS: chain.deployment.address,
    POLICY_DEPLOY_BLOCK: chain.deployment.blockNumber.toString(),
    AGENT_PRIVATE_KEY: agentKey,
    CONSOLE_URL: `http://127.0.0.1:${consolePort}`,
    CONSOLE_SERVICE_TOKEN: consoleToken,
  });
  process.stdout.write(
    `  chain ${chain.rpcUrl}, Policy ${chain.deployment.address}; console :${consolePort}; MCP ${server.base}/mcp\n`,
  );
  const run = (name: string, args: Structured = {}) => call(server.base, mcpToken, name, args);

  try {
    process.stdout.write("\n-- setup\n");
    const setup = await run("get_setup_state");
    check(
      field(setup.structuredContent, "nextAction", "actor") === "agent",
      "a fresh connection is told to request pairing",
    );
    const pairing = await run("request_pairing", { agentName: "Grok Bot" });
    check(
      field(pairing.structuredContent, "status") === "held",
      "pairing waits for the owner, with a claim link",
    );
    fake.confirmPairing();
    process.stdout.write("  (owner confirms the agent on the claim page)\n");
    check(
      field((await run("get_setup_state")).structuredContent, "ready") === true,
      "setup is complete after the owner confirms",
    );

    process.stdout.write("\n-- read\n");
    const policy = await run("get_policy");
    check(
      field(policy.structuredContent, "policy", "contract", "contextHash") === extended,
      "get_policy reports the contract's extensions",
    );
    await run("get_portfolio");
    await run("list_markets", { limit: 5 });
    let ladder: CallResult | undefined;
    for (const horizon of ["weekly", "daily", "month-end", "hourly"]) {
      ladder = await run("get_ladder", { asset: "BTC", horizon });
      if (field(ladder.structuredContent, "status") === "ok") break;
    }
    const rungs = (field(ladder?.structuredContent, "ladder", "rungs") ?? []) as {
      instrumentSymbol: string;
      strikeCents: number;
      marketState: string | null;
    }[];
    const spot = Number(field(ladder?.structuredContent, "ladder", "spotCents"));
    const open = rungs.filter((r) => r.marketState === "open");
    const market = [...open].reverse().find((r) => r.strikeCents < spot) ?? open[0] ?? rungs[0];
    if (market === undefined) throw new Error("Gemini returned no BTC ladder to trade on");
    const eventTicker = String(field(ladder?.structuredContent, "ladder", "eventTicker"));

    process.stdout.write("\n-- plan\n");
    const plan = await run("plan_hedge", {
      asset: "BTC",
      dropPercent: 3,
      maxCostCents: 4_000,
      eventTicker,
      requestText: "Protect my 0.05 BTC against a 3% drop this week, for at most $40.",
    });
    const planId = field(plan.structuredContent, "plan", "planId");

    process.stdout.write("\n-- simulate\n");
    const simulated = await run("simulate_trade", {
      market: market.instrumentSymbol,
      outcome: "NO",
      amountCents: 3_000,
      limitPrice: 40,
    });
    check(
      field(simulated.structuredContent, "simulation", "wouldBe") === "rejected",
      "simulate_trade predicts the $30 rejection",
    );
    check(
      field(simulated.structuredContent, "simulation", "source") === (extended ? "contract" : "offchain"),
      `simulate_trade uses ${extended ? "the contract's previewTrade" : "the offchain evaluator"}`,
    );

    process.stdout.write("\n-- the three demo cases\n");
    const trade = {
      market: market.instrumentSymbol,
      outcome: "NO",
      limitPrice: 40,
      requestText: "Hedge my BTC.",
    };
    const approved = await run("propose_trade", {
      ...trade,
      amountCents: 1_000,
      reason: "Owner asked for a small hedge below spot.",
    });
    const blocked = await run("propose_trade", {
      ...trade,
      amountCents: 3_000,
      reason: "Owner asked for a larger hedge.",
    });
    const held = await run("propose_trade", {
      ...trade,
      amountCents: 2_200,
      reason: "Owner asked for a $22 hedge.",
    });
    check(field(approved.structuredContent, "status") === "approved", "approved: $10 buy");
    check(
      field(blocked.structuredContent, "status") === "rejected" &&
        field(blocked.structuredContent, "proposal", "rule", "contractReason") === "over max trade size",
      "blocked with the contract's reason: over max trade size",
    );
    check(field(held.structuredContent, "status") === "held", "waiting for the owner's approval: $22 buy");
    const replay = await run("propose_trade", {
      ...trade,
      amountCents: 1_000,
      reason: "Owner asked for a small hedge below spot.",
    });
    check(
      field(replay.structuredContent, "replayed") === true &&
        field(replay.structuredContent, "proposal", "intentId") ===
          field(approved.structuredContent, "proposal", "intentId"),
      "a retried proposal returns the first result and trades once",
    );
    for (const [label, result] of [
      ["approved", approved],
      ["blocked", blocked],
      ["held", held],
    ] as const) {
      const hash = String(field(result.structuredContent, "proposal", "context", "hash"));
      const stored = fake.state.contexts.get(hash.toLowerCase());
      check(
        stored !== undefined && verifyContext(stored.document, hash),
        `${label}: decision context stored in the console and matches its hash`,
      );
      check(
        field(result.structuredContent, "proposal", "context", "contextHashRecorded") === extended,
        `${label}: contextHashRecorded is ${String(extended)}`,
      );
    }

    process.stdout.write("\n-- execute the plan (a different MCP session from plan_hedge)\n");
    if (
      typeof planId === "string" &&
      Number(field(plan.structuredContent, "plan", "totals", "orderCount")) > 0
    ) {
      const executed = await run("execute_plan", { planId, reason: "The owner agreed to the plan." });
      check(
        field(executed.structuredContent, "execution", "remaining") === 0,
        "execute_plan answered every order or stopped at a rejection",
      );
      const again = await run("execute_plan", { planId, reason: "The owner agreed to the plan." });
      check(
        field(again.structuredContent, "execution", "submitted") ===
          field(executed.structuredContent, "execution", "submitted"),
        "executing the plan again sends nothing new",
      );
    } else {
      process.stdout.write("  (the live ladder gave an empty plan; skipping execute_plan)\n");
    }

    process.stdout.write("\n-- follow up\n");
    const intentId = Number(field(approved.structuredContent, "proposal", "intentId"));
    const intent = await run("get_intent", { intentId });
    check(
      field(intent.structuredContent, "intent", "context", "document") === "verified",
      "get_intent verifies the stored context",
    );
    const blockedIntent = await run("get_intent", {
      intentId: Number(field(blocked.structuredContent, "proposal", "intentId")),
    });
    check(
      field(blockedIntent.structuredContent, "intent", "reason") === "over max trade size",
      "the rejection reason is read back from the chain",
    );
    await run("get_activity", { limit: 5 });
    const change = await run("request_policy_change", {
      maxTradeCents: 5_000,
      reason: "The owner wants $50 rungs.",
    });
    check(
      field(change.structuredContent, "status") === "held" && fake.state.changeRequests.size === 1,
      "request_policy_change files a request for the owner",
    );
    const unpause = await run("request_policy_change", { paused: false, reason: "Resume." });
    check(unpause.isError === true, "a request to change the pause switch is refused");

    const logs = server.logs.join("\n");
    check(
      !logs.includes(agentKey.slice(2)) && !logs.includes(mcpToken) && !logs.includes(consoleToken),
      "no key or token appears in the server's logs",
    );
  } catch (error) {
    failures += 1;
    process.stdout.write(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(`  last server log lines:\n${server.logs.slice(-15).join("\n")}\n`);
  } finally {
    await stop(server.child);
    consoleServer.close();
    await chain.stop();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { contract: { type: "string", default: "both" } } });
  const wanted = values.contract === "both" ? (["production", "reference"] as const) : [values.contract];
  const contracts = wanted.filter((kind): kind is PolicyContractKind => isPolicyContractKind(kind));
  if (contracts.length !== wanted.length) {
    process.stderr.write("--contract must be production, reference or both\n");
    process.exit(1);
  }
  process.stdout.write("Compiling the Policy contracts...\n");
  buildContracts();
  for (const contract of contracts) await runOne(contract);
  process.stdout.write(failures === 0 ? "\nE2E OK\n" : `\nE2E FAILED: ${failures} check(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`E2E FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
