/**
 * `npm run signal:e2e`: one real paid run of the hedge signal on Arc testnet, end to end.
 *
 * 1. Starts the signal API and the MCP server on free local ports. Both load the `.env` file
 *    themselves (`ENV_FILE` is passed through), and the MCP server keeps its spend ledger and the
 *    purchased signals in `.data/signal-e2e`, apart from a normal run's data.
 * 2. Connects to the MCP server over HTTP with the official SDK client, as Grok Bot does, and calls
 *    `buy_signal`, which pays the signal API from the buyer's Circle Gateway balance.
 * 3. Loads the purchase by its receipt id, as `plan_hedge` will, fetches the same ladder from Gemini
 *    and plans a hedge with and without the signal.
 * 4. Looks the payment up in Circle Gateway's transfer history by receipt id and waits a little for
 *    the batch settlement transaction (`npm run x402:status` shows it later if it is slow).
 *
 * It spends the signal price once per run (default 0.001 USDC) and never deposits. Only public
 * addresses, receipt ids and transfer ids are printed; keys and the MCP token are never printed.
 *
 *   ENV_FILE=/path/to/.env npm run signal:e2e -- [--asset BTC] [--horizon weekly] [--wait-seconds 90]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createGeminiClient } from "@mandate/gemini";
import { formatUsd, planHedge, summarizePlan, type HedgeInput } from "@mandate/planner";
import { ARC_TESTNET, explorerTxUrl, SIGNAL_HORIZONS, type SignalHorizon } from "@mandate/shared";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hex } from "viem";
import { loadEnvFile, resolveEnvFile } from "../src/env-file";
import { SignalStore } from "../src/x402/signal-store";

const REPO = resolve(import.meta.dirname, "..", "..");
const DATA_DIR = join(REPO, ".data", "signal-e2e");

const { values } = parseArgs({
  options: {
    asset: { type: "string", default: "BTC" },
    horizon: { type: "string", default: "weekly" },
    "wait-seconds": { type: "string", default: "90" },
  },
});
const asset = values.asset.toUpperCase();
const horizon = values.horizon as SignalHorizon;
const waitSeconds = Number(values["wait-seconds"]);

const children: { name: string; process: ChildProcess; output: string[] }[] = [];

function fail(message: string): never {
  process.stderr.write(`FAIL ${message}\n`);
  for (const child of children) {
    process.stderr.write(`--- last output of ${child.name} ---\n${child.output.slice(-20).join("")}\n`);
  }
  stopChildren();
  process.exit(1);
}

function stopChildren(): void {
  for (const child of children) child.process.kill("SIGTERM");
}

const say = (line: string) => process.stdout.write(`${line}\n`);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

/** Runs a TypeScript entry point with tsx; the child reads the .env file itself. */
function start(name: string, entry: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { name, process: child, output: [] as string[] };
  const keep = (chunk: Buffer) => record.output.push(chunk.toString("utf8"));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) record.output.push(`(exited with code ${code.toString()})\n`);
  });
  children.push(record);
}

async function waitForHealth(name: string, url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${name} did not answer ${url} within 30 s`);
}

function summaryOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.map((block) => block.text ?? `[${block.type}]`).join(" ");
}

interface BuySignalResult {
  status: string;
  reasons: { code: string; message: string }[];
  receiptId: string | null;
  signalId: string | null;
  priceUsdc: string | null;
  budget: { dailyUsdc: string; spentTodayUsdc: string; remainingUsdc: string };
  signal: {
    eventTicker: string;
    realizedVolBps: number;
    counts: Record<string, number>;
    strikes: { strikeCents: number; noAskCents: number | null; edgeCents: number | null; verdict: string }[];
  } | null;
}

async function main(): Promise<void> {
  if (!SIGNAL_HORIZONS.includes(horizon)) fail(`--horizon must be one of ${SIGNAL_HORIZONS.join(", ")}`);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0) fail("--wait-seconds must be a whole number");

  // Children get the environment as it was before the .env file is loaded here, plus ENV_FILE.
  const inherited = { ...process.env };
  const envFile = resolveEnvFile();
  if (!loadEnvFile(envFile)) fail(`no .env file at ${envFile}; set ENV_FILE`);
  const token = process.env["MCP_AUTH_TOKEN"];
  if (token === undefined || token === "") fail("MCP_AUTH_TOKEN is not set in the .env file");
  const buyerKey = process.env["X402_BUYER_PRIVATE_KEY"];
  if (buyerKey === undefined || buyerKey === "") fail("X402_BUYER_PRIVATE_KEY is not set in the .env file");

  const signalsPort = await freePort();
  const mcpPort = await freePort();
  const signalsUrl = `http://127.0.0.1:${signalsPort.toString()}`;
  const mcpUrl = `http://127.0.0.1:${mcpPort.toString()}`;

  start("signals", "signals/src/server.ts", {
    ...inherited,
    ENV_FILE: envFile,
    SIGNALS_PORT: signalsPort.toString(),
  });
  start("mcp", "agent/src/main.ts", {
    ...inherited,
    ENV_FILE: envFile,
    MCP_HOST: "127.0.0.1",
    MCP_PORT: mcpPort.toString(),
    SIGNALS_URL: signalsUrl,
    AGENT_DATA_DIR: DATA_DIR,
  });
  await waitForHealth("signals", `${signalsUrl}/health`);
  await waitForHealth("mcp", `${mcpUrl}/health`);
  say(`signal API  ${signalsUrl}`);
  say(`MCP server  ${mcpUrl}/mcp (data in ${DATA_DIR})`);

  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: buyerKey as Hex });
  const before = await gateway.getBalances();
  say(`buyer       ${gateway.address}, Gateway available ${before.gateway.formattedAvailable} USDC`);

  const discovery = (await (await fetch(`${signalsUrl}/v1/resources`)).json()) as {
    resources: { path: string; priceUsd: string; amount: string }[];
  };
  const listed = discovery.resources.find((r) => r.path === "/v1/signal/hedge");
  say(`discovery   /v1/signal/hedge costs $${listed?.priceUsd ?? "?"} (${listed?.amount ?? "?"} base units)`);

  const client = new Client({ name: "mandate-signal-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === "buy_signal")) fail("the MCP server does not list buy_signal");

  say("");
  say(`> buy_signal { asset: "${asset}", horizon: "${horizon}" }`);
  const result = await client.callTool({ name: "buy_signal", arguments: { asset, horizon } });
  await client.close();
  if (result.isError === true) fail(`buy_signal: ${summaryOf(result)}`);
  const bought = result.structuredContent as BuySignalResult;
  say(summaryOf(result));
  say(
    `status ${bought.status}, price ${bought.priceUsdc ?? "-"} USDC, budget left ${bought.budget.remainingUsdc} of ${bought.budget.dailyUsdc} USDC`,
  );
  if (bought.status !== "approved" || bought.receiptId === null || bought.signal === null) {
    fail(`buy_signal did not buy a signal: ${bought.reasons.map((r) => r.code).join(", ")}`);
  }
  const receiptId = bought.receiptId;
  say(`${"strike".padStart(11)}  ${"NO ask".padStart(6)}  ${"edge".padStart(4)}  verdict`);
  for (const strike of bought.signal.strikes) {
    say(
      `${formatUsd(strike.strikeCents).padStart(11)}  ${(strike.noAskCents === null ? "-" : `${strike.noAskCents.toString()}c`).padStart(6)}  ${(strike.edgeCents === null ? "-" : `${strike.edgeCents > 0 ? "+" : ""}${strike.edgeCents.toString()}c`).padStart(4)}  ${strike.verdict}`,
    );
  }

  // As plan_hedge will: the purchase by receipt id from the server's store, and the live ladder.
  const purchase = SignalStore.open(join(DATA_DIR, "signals")).load(receiptId);
  if (purchase === undefined) fail(`no stored purchase for receipt ${receiptId}`);
  const ladder = await createGeminiClient().getLadder({
    asset,
    eventTicker: purchase.signal.eventTicker,
    depth: "below-spot",
  });
  const input: HedgeInput = {
    holding: { asset, quantity: "0.05" },
    ladder,
    goal: { dropPercent: 8 },
    maxCostCents: 1_500,
    limits: { maxTradeCents: 10_000, remainingBudgetCents: 100_000, categoryAllowed: true },
  };
  const without = planHedge(input);
  const withSignal = planHedge({ ...input, signal: { receiptId, signal: purchase.signal } });
  say("");
  say(`> planHedge, 0.05 ${asset} down 8 %, at most ${formatUsd(input.maxCostCents)}`);
  say(`without signal: ${summarizePlan(without)}`);
  say(
    `  buys ${without.rungs.map((r) => `${formatUsd(r.strikeCents)} x${r.quantity}`).join(", ") || "nothing"}`,
  );
  say(`with signal:    ${summarizePlan(withSignal)}`);
  say(
    `  buys ${withSignal.rungs.map((r) => `${formatUsd(r.strikeCents)} x${r.quantity}`).join(", ") || "nothing"}`,
  );
  say(`  signal use: ${JSON.stringify({ ...withSignal.signal, rungs: undefined })}`);

  say("");
  say(`> Gateway transfer for receipt ${receiptId}`);
  const deadline = Date.now() + waitSeconds * 1_000;
  let lastStatus = "";
  for (;;) {
    const { transfers } = await gateway.searchTransfers({
      nonce: receiptId as Hex,
      network: ARC_TESTNET.network,
    });
    const transfer = transfers[0];
    if (transfer !== undefined && transfer.status !== lastStatus) {
      lastStatus = transfer.status;
      const txHash = typeof transfer["txHash"] === "string" ? transfer["txHash"] : null;
      say(
        `transfer ${transfer.id}: ${transfer.status}, ${transfer.amount} base units ${transfer.fromAddress} -> ${transfer.toAddress}${txHash === null ? "" : `, settled in ${explorerTxUrl(txHash)}`}`,
      );
      if (txHash !== null || transfer.status === "completed" || transfer.status === "failed") break;
    }
    if (Date.now() >= deadline) {
      say(
        transfer === undefined
          ? "Gateway does not list the transfer yet."
          : `not settled after ${waitSeconds.toString()} s; check later with npm run x402:status`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const after = await gateway.getBalances();
  say(
    `buyer       Gateway available ${after.gateway.formattedAvailable} USDC (was ${before.gateway.formattedAvailable})`,
  );

  stopChildren();
  say("OK");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
});
