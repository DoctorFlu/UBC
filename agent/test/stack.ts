/**
 * A whole local stack for end-to-end tests, the way Grok Bot meets it: a real anvil chain with a
 * freshly deployed Policy contract and the demo rules, the simulated executor filling approved
 * intents, an in-memory console over HTTP, and the real MCP server code over HTTP. Every tool call
 * opens a fresh MCP session, as Grok Bot does. Only Gemini's market data is a fixture, so a test can
 * move the spot price between calls.
 *
 * Every key is a public anvil test key; every port is picked by the operating system.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildLadder, type Ladder, type SpotPrice } from "@mandate/gemini";
import {
  devPolicyClient,
  devPrivateKey,
  simulatedVenue,
  startDevchain,
  startExecutor,
  type Devchain,
  type PolicyContractKind,
  type Executor,
} from "@mandate/devchain";
import type { Intent, PolicyClient, PolicyRules } from "@mandate/shared";
import { createMandateServer, type MandateServer } from "../src/app";
import { parseConfig } from "../src/config";
import { silentLogger } from "../src/logger";
import { createFakeConsole, type FakeConsole } from "../testing/fake-console";
import { FakeMarkets, ladderEvent } from "./fakes";

export type Structured = Record<string, unknown>;

export interface ToolResult {
  isError: boolean;
  structured: Structured;
  text: string;
}

/** Reads a nested field of a tool result without trusting its shape. */
export const field = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );

/**
 * The fixture ladder (`fakes.ts`) at a spot price the test controls. `driftCents` is added to the
 * spot after every ladder read, so two reads at the same moment see slightly different prices, as
 * they would on a live market.
 */
export class MovingMarkets extends FakeMarkets {
  spotCents: number;
  driftCents = 0;

  constructor(spotCents: number) {
    super();
    this.spotCents = spotCents;
  }

  #spot(): SpotPrice {
    return {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: this.spotCents,
      askCents: this.spotCents,
      lastCents: this.spotCents,
      midCents: this.spotCents,
      fetchedAt: new Date().toISOString(),
    };
  }

  override async getLadder(): Promise<Ladder> {
    await super.getLadder();
    const ladder = buildLadder(ladderEvent(), this.#spot(), { fetchedAt: new Date().toISOString() });
    if (ladder === null) throw new Error("fixture is not a ladder");
    this.spotCents += this.driftCents;
    return ladder;
  }

  override async getSpot(): Promise<SpotPrice> {
    await super.getSpot();
    return this.#spot();
  }
}

export interface Stack {
  chain: Devchain;
  markets: MovingMarkets;
  console: FakeConsole;
  server: MandateServer;
  /** Reads the contract as anyone can. */
  reader: PolicyClient;
  /** One tool call in a fresh MCP session. */
  call: (name: string, args?: Structured) => Promise<ToolResult>;
  /** Every intent the contract stores, oldest first. */
  intents: () => Promise<Intent[]>;
  /** Resolves once the executor has recorded a result for every approved intent. */
  settled: () => Promise<void>;
  stop: () => Promise<void>;
}

function listen(fetch: (request: Request) => Promise<Response> | Response): Promise<{
  server: ServerType;
  url: string;
}> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({ server, url: `http://127.0.0.1:${info.port.toString()}` });
    });
  });
}

function close(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function startStack(options: {
  holdings: { asset: string; quantity: string }[];
  spotCents: number;
  contract?: PolicyContractKind;
  rules?: PolicyRules;
}): Promise<Stack> {
  const chain = await startDevchain({
    contract: options.contract ?? "production",
    port: 0,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const servers: ServerType[] = [];
  let executor: Executor | undefined;
  try {
    const policy = chain.deployment.address;
    const reader = devPolicyClient(chain.rpcUrl, policy, "outsider");
    const markets = new MovingMarkets(options.spotCents);

    executor = startExecutor({
      client: devPolicyClient(chain.rpcUrl, policy, "executor"),
      venue: simulatedVenue(new FakeMarkets()),
      fromBlock: chain.deployment.blockNumber,
      fillDelayMs: 0,
      pollingIntervalMs: 100,
      log: () => undefined,
    });

    const consoleToken = randomBytes(24).toString("base64url");
    const fake = createFakeConsole({
      token: consoleToken,
      holdings: options.holdings,
      isContractAgent: async (address) =>
        (await reader.getRoles()).agent.toLowerCase() === address.toLowerCase(),
    });
    const consoleHttp = await listen(fake.fetch);
    servers.push(consoleHttp.server);

    const mcpToken = randomBytes(32).toString("base64url");
    const server = createMandateServer(
      parseConfig({
        MCP_AUTH_TOKEN: mcpToken,
        MCP_HOST: "127.0.0.1",
        ARC_RPC_URL: chain.rpcUrl,
        POLICY_ADDRESS: policy,
        POLICY_DEPLOY_BLOCK: chain.deployment.blockNumber.toString(),
        AGENT_PRIVATE_KEY: devPrivateKey("agent"),
        CONSOLE_URL: consoleHttp.url,
        CONSOLE_SERVICE_TOKEN: consoleToken,
      }),
      silentLogger,
      { services: { markets } },
    );
    const mcpHttp = await listen(server.fetch);
    servers.push(mcpHttp.server);
    const endpoint = new URL("/mcp", mcpHttp.url);

    const call = async (name: string, args: Structured = {}): Promise<ToolResult> => {
      const client = new Client({ name: "mandate-routine-test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
        }),
      );
      try {
        const result = (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
          structuredContent?: Structured;
          content?: { type: string; text?: string }[];
        };
        return {
          isError: result.isError === true,
          structured: result.structuredContent ?? {},
          text: (result.content ?? []).map((block) => block.text ?? "").join(" "),
        };
      } finally {
        await client.close();
      }
    };

    const intents = async (): Promise<Intent[]> => {
      const count = await reader.getIntentCount();
      const read = await Promise.all(Array.from({ length: count }, (_, id) => reader.getIntent(id)));
      return read.filter((intent): intent is Intent => intent !== null);
    };

    const settled = async (): Promise<void> => {
      // The executor answers within a few polling intervals; give up long before the test does.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await intents()).some((intent) => intent.status === "approved")) return;
        await sleep(100);
      }
      throw new Error("the simulated executor did not fill every approved intent");
    };

    // The owner pairs the agent once, as in the setup flow.
    const paired = await call("request_pairing", { agentName: "Grok Bot" });
    if (paired.isError) throw new Error(`request_pairing failed: ${paired.text}`);
    fake.confirmPairing();

    const running = executor;
    return {
      chain,
      markets,
      console: fake,
      server,
      reader,
      call,
      intents,
      settled,
      stop: async () => {
        running.stop();
        await server.endpoint.close();
        await Promise.all(servers.map(close));
        await chain.stop();
      },
    };
  } catch (error) {
    executor?.stop();
    await Promise.all(servers.map(close));
    await chain.stop();
    throw error;
  }
}
