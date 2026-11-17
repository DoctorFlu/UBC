/**
 * The two places the red team can attack:
 * - `self`: a devchain on a free port with the demo rules, an in-memory console and the real MCP
 *   server code served over HTTP on another free port, all started and stopped here. Nothing else
 *   on the machine is touched.
 * - `stack`: the running `npm run dev:stack`, so the attempts show up in the console. It refuses to
 *   run against anything that is not a loopback anvil devchain whose roles are the public test
 *   accounts, and it signs only with those public test keys.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { createLogger, createMandateServer, parseConfig, type MarketsClient } from "@mandate/agent";
import { createFakeConsole } from "@mandate/agent/testing";
import {
  buildContracts,
  devAccount,
  devPolicyClient,
  devPrivateKey,
  simulatedVenue,
  startDevchain,
  type PolicyContractKind,
  type Venue,
} from "@mandate/devchain";
import { createGeminiClient } from "@mandate/gemini";
import {
  CATEGORY_IDS,
  categoryLabel,
  isCategoryAllowed,
  loadEnv,
  PolicyClient,
  type PolicyRules,
} from "@mandate/shared";
import { localDeploymentPath, resolvePolicyDeployment } from "@mandate/shared/node";
import { ChainAttacker, readClient } from "./chain";
import { CRYPTO_SYMBOL, fixtureMarkets, SPORTS_SYMBOL } from "./fixtures";
import { field, McpAttacker } from "./mcp";

/** Ports the live stack uses. The self-contained run never binds them. */
const RESERVED_PORTS = new Set([3000, 8545, 8787, 8788]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface TargetHandle {
  target: "self" | "stack";
  contract: string;
  rpcUrl: string;
  chainId: number;
  policy: Address;
  mcpUrl: string;
  mcp: McpAttacker;
  chain: ChainAttacker;
  reader: PolicyClient;
  owner: PolicyClient;
  executor: PolicyClient | null;
  markets: { crypto: string; sports: string | null };
  /** The executor's market lookup: the recorded markets on our own chain, Gemini against the stack. */
  venue: Venue;
  /** The server's log lines, for the self-contained run only. */
  serverLogs: string[];
  stop: () => Promise<void>;
}

export class TargetRefused extends Error {
  override name = "TargetRefused";
}

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

function close(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/** The event lookup the simulated venue reads outcomes with, from the agent's market data. */
function eventsOf(markets: MarketsClient): Parameters<typeof simulatedVenue>[0] {
  return { getEvent: (eventTicker) => markets.getEvent(eventTicker) };
}

function agentAttacker(rpcUrl: string, chainId: number, policy: Address): ChainAttacker {
  return new ChainAttacker({ rpcUrl, chainId, policy, account: privateKeyToAccount(devPrivateKey("agent")) });
}

// ------------------------------------------------------------------ self-contained

export async function startSelf(options: {
  contract: PolicyContractKind;
  build?: boolean;
}): Promise<TargetHandle> {
  if (options.build !== false) buildContracts();
  const devchain = await startDevchain({ contract: options.contract, port: await freePort() });
  const servers: ServerType[] = [];
  try {
    const policy = devchain.deployment.address;
    const chainId = await readClient(devchain.rpcUrl).getChainId();
    const reader = new PolicyClient({ address: policy, publicClient: readClient(devchain.rpcUrl, chainId) });

    const consoleToken = randomBytes(24).toString("base64url");
    const consolePort = await freePort();
    const fakeConsole = createFakeConsole({
      token: consoleToken,
      publicUrl: `http://127.0.0.1:${consolePort}`,
      isContractAgent: async (address) =>
        (await reader.getRoles()).agent.toLowerCase() === address.toLowerCase(),
    });
    servers.push(serve({ fetch: fakeConsole.fetch, port: consolePort, hostname: "127.0.0.1" }));

    // The real server code: config, tools, HTTP limits and auth. Only the market data is a fixture.
    const mcpToken = randomBytes(32).toString("base64url");
    const mcpPort = await freePort();
    const serverLogs: string[] = [];
    const config = parseConfig({
      MCP_AUTH_TOKEN: mcpToken,
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(mcpPort),
      ARC_RPC_URL: devchain.rpcUrl,
      POLICY_ADDRESS: policy,
      POLICY_DEPLOY_BLOCK: devchain.deployment.blockNumber.toString(),
      AGENT_PRIVATE_KEY: devPrivateKey("agent"),
      CONSOLE_URL: `http://127.0.0.1:${consolePort}`,
      CONSOLE_SERVICE_TOKEN: consoleToken,
    });
    const server = createMandateServer(
      config,
      createLogger({ level: "info", sink: (line) => serverLogs.push(line) }),
      {
        services: { markets: fixtureMarkets() },
      },
    );
    servers.push(serve({ fetch: server.fetch, port: mcpPort, hostname: "127.0.0.1" }));
    const mcpUrl = `http://127.0.0.1:${mcpPort}`;

    return {
      target: "self",
      contract: options.contract,
      rpcUrl: devchain.rpcUrl,
      chainId,
      policy,
      mcpUrl: `${mcpUrl}/mcp`,
      mcp: new McpAttacker(mcpUrl, mcpToken),
      chain: agentAttacker(devchain.rpcUrl, chainId, policy),
      reader,
      owner: devPolicyClient(devchain.rpcUrl, policy, "user"),
      executor: devPolicyClient(devchain.rpcUrl, policy, "executor"),
      markets: { crypto: CRYPTO_SYMBOL, sports: SPORTS_SYMBOL },
      venue: simulatedVenue(eventsOf(fixtureMarkets())),
      serverLogs,
      stop: async () => {
        await server.endpoint.close();
        await Promise.all(servers.map(close));
        await devchain.stop();
      },
    };
  } catch (error) {
    await Promise.all(servers.map(close));
    await devchain.stop();
    throw error;
  }
}

// ------------------------------------------------------------------ the live stack

async function rpc(url: string, method: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as { result?: unknown };
  return body.result;
}

/** A Gemini market in a category the rules do not allow, Sports first. */
async function disallowedMarket(rules: PolicyRules): Promise<string | null> {
  const gemini = createGeminiClient({ maxRetries: 1, timeoutMs: 8_000 });
  const wanted = [
    "Sports",
    ...CATEGORY_IDS.map(categoryLabel).filter((name) => name !== "Sports" && name !== "Other"),
  ];
  for (const name of wanted) {
    const id = CATEGORY_IDS.find((c) => categoryLabel(c) === name);
    if (id === undefined || isCategoryAllowed(rules.allowedCategories, id)) continue;
    const events = await gemini.listEvents({ category: name, maxPages: 1 }).catch(() => []);
    for (const summary of events.slice(0, 5)) {
      const event = await gemini.getEvent(summary.ticker).catch(() => null);
      const contract = event?.contracts.find((c) => c.marketState === "open") ?? event?.contracts[0];
      if (contract !== undefined) return contract.instrumentSymbol;
    }
  }
  return null;
}

/** An open crypto rung, found through the server's own get_ladder tool, as Grok Bot would. */
async function cryptoMarket(mcp: McpAttacker): Promise<string> {
  for (const horizon of ["weekly", "daily", "month-end", "hourly"]) {
    const ladder = await mcp.call("get_ladder", { asset: "BTC", horizon });
    const rungs = (field(ladder.structured, "ladder", "rungs") ?? []) as {
      instrumentSymbol: string;
      marketState: string | null;
    }[];
    const open = rungs.find((r) => r.marketState === "open") ?? rungs[0];
    if (open !== undefined) return open.instrumentSymbol;
  }
  throw new TargetRefused("Gemini returned no BTC ladder through the MCP server's get_ladder tool");
}

/**
 * Connects to the running stack after checking, in order, that the deployment file describes a
 * loopback anvil devchain, that its roles are the public test accounts, and that the MCP server on
 * loopback is wired to the same contract with the same agent.
 */
export async function connectStack(): Promise<TargetHandle> {
  // The existing env loader: the MCP server's token and port. The token is never printed.
  loadEnv();
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  if (!token) throw new TargetRefused("MCP_AUTH_TOKEN is not set in the environment or .env");
  const mcpPort = Number(process.env.MCP_PORT ?? 8787);
  if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65_535)
    throw new TargetRefused("MCP_PORT is not a port");

  // Only the local deployment file counts: a POLICY_ADDRESS in .env (Arc testnet) is ignored on purpose.
  const deploymentFile = localDeploymentPath();
  let deployment;
  try {
    deployment = resolvePolicyDeployment({ env: {}, localPath: deploymentFile });
  } catch (error) {
    throw new TargetRefused(
      `no local devchain deployment (${error instanceof Error ? error.message : String(error)}). Is \`npm run dev:stack\` running?`,
    );
  }
  if (deployment.source !== "devchain" || deployment.local === null) {
    throw new TargetRefused("the deployment does not come from the local devchain file");
  }
  const rpcUrl = deployment.rpcUrl;
  const host = new URL(rpcUrl).hostname;
  if (!LOOPBACK_HOSTS.has(host)) throw new TargetRefused(`the RPC host ${host} is not loopback`);
  const client = String(await rpc(rpcUrl, "web3_clientVersion").catch(() => ""));
  if (!client.toLowerCase().startsWith("anvil")) {
    throw new TargetRefused(`the RPC at ${rpcUrl} is not anvil (client "${client || "no answer"}")`);
  }
  const chainId = Number(await rpc(rpcUrl, "eth_chainId"));
  if (chainId !== deployment.local.chainId) {
    throw new TargetRefused(
      `the RPC's chain id ${chainId} differs from the deployment file's ${deployment.local.chainId}`,
    );
  }
  const publicClient = readClient(rpcUrl, chainId);
  const policy = deployment.address;
  const code = await publicClient.getCode({ address: policy });
  if (code === undefined || code === "0x") throw new TargetRefused(`no contract at ${policy}`);

  const reader = new PolicyClient({ address: policy, publicClient });
  const roles = await reader.getRoles();
  for (const role of ["user", "agent", "executor"] as const) {
    if (roles[role].toLowerCase() !== devAccount(role).address.toLowerCase()) {
      throw new TargetRefused(
        `the contract's ${role} is ${roles[role]}, not the public devchain ${role} account`,
      );
    }
  }

  const mcpBase = `http://127.0.0.1:${mcpPort}`;
  const health = await fetch(`${mcpBase}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (health?.ok !== true) throw new TargetRefused(`no MCP server answers on ${mcpBase}/health`);
  const mcp = new McpAttacker(mcpBase, token);
  const whoami = await mcp.call("whoami");
  if (whoami.isError)
    throw new TargetRefused(`whoami failed on the MCP server: ${whoami.errorCode ?? "error"}`);
  const agent = String(field(whoami.structured, "agentAddress"));
  const serverPolicy = String(field(whoami.structured, "policyAddress"));
  const serverRpcHost = String(field(whoami.structured, "chain", "rpcHost"));
  if (agent.toLowerCase() !== roles.agent.toLowerCase()) {
    throw new TargetRefused(`the MCP server's agent ${agent} is not the contract's agent`);
  }
  if (serverPolicy.toLowerCase() !== policy.toLowerCase()) {
    throw new TargetRefused(`the MCP server uses Policy ${serverPolicy}, not the devchain's ${policy}`);
  }
  if (!LOOPBACK_HOSTS.has(serverRpcHost.replace(/:\d+$/, ""))) {
    throw new TargetRefused(`the MCP server's RPC host ${serverRpcHost} is not loopback`);
  }

  const rules = await reader.getRules();
  const [crypto, sports] = await Promise.all([cryptoMarket(mcp), disallowedMarket(rules)]);
  return {
    target: "stack",
    contract: deployment.local.contract,
    rpcUrl,
    chainId,
    policy,
    mcpUrl: `${mcpBase}/mcp`,
    mcp,
    chain: agentAttacker(rpcUrl, chainId, policy),
    reader,
    owner: devPolicyClient(rpcUrl, policy, "user"),
    executor: null,
    markets: { crypto, sports },
    venue: simulatedVenue(createGeminiClient({ maxRetries: 1, timeoutMs: 8_000 })),
    serverLogs: [],
    stop: () => Promise.resolve(),
  };
}
