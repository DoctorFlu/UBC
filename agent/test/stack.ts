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
import {
  buildLadder,
  type Ladder,
  type LadderListing,
  type MarketEvent,
  type SpotPrice,
} from "@mandate/gemini";
import {
  consoleSettlementSink,
  devAccount,
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
import type { Clock } from "../src/context";
import { silentLogger, type Logger } from "../src/logger";
import type { MarketsClient, PaymentsClient } from "../src/services";
import { createFakeConsole, type FakeConsole } from "../testing/fake-console";
import { coverFromPlans } from "../testing/fake-cover";
import { EXPIRY, FakeMarkets, LADDER_TICKER, ladderEvent } from "./fakes";

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

/** The weekly ladder after the fixture's: Gemini lists it once the fixture's has expired. */
export const NEXT_LADDER_TICKER = "BTC2611272200";
const NEXT_EXPIRY = "2026-11-27T22:00:00.000Z";

/** The fixture ladder a week later: same strikes and quotes, the next expiry. */
function nextLadderEvent(): MarketEvent {
  const event = ladderEvent();
  return {
    ...event,
    id: "3",
    ticker: NEXT_LADDER_TICKER,
    title: "BTC price on November 27",
    expiry: NEXT_EXPIRY,
    contracts: event.contracts.map((contract) => ({
      ...contract,
      instrumentSymbol: contract.instrumentSymbol.replace(LADDER_TICKER, NEXT_LADDER_TICKER),
      expiry: NEXT_EXPIRY,
    })),
  };
}

/**
 * The fixture ladder (`fakes.ts`) at a spot price the test controls. `driftCents` is added to the
 * spot after every ladder read, so two reads at the same moment see slightly different prices, as
 * they would on a live market. `expire` moves the ladder past its expiry, as Gemini shows it then.
 */
export class MovingMarkets extends FakeMarkets {
  spotCents: number;
  driftCents = 0;
  /** The ladder plans go on: the fixture's, then the next one once it has expired. */
  current: MarketEvent = ladderEvent();

  constructor(spotCents: number) {
    super();
    this.spotCents = spotCents;
  }

  /**
   * The current ladder expires and BTC settles at `settlementCents`: Gemini publishes each strike's
   * outcome on the old event (YES at or above the strike) and lists the next weekly ladder, the only
   * one a plan can go on now.
   */
  expire(settlementCents: number): void {
    const old = this.current;
    const resolvedAt = new Date(Date.parse(old.expiry ?? NEXT_EXPIRY) + 8_232).toISOString();
    const settled: MarketEvent = {
      ...old,
      status: "settled",
      contracts: old.contracts.map((contract) => ({
        ...contract,
        status: "settled",
        marketState: "closed",
        resolutionSide: settlementCents >= (contract.strike?.valueCents ?? 0) ? "yes" : "no",
        resolvedAt,
        settlementValue: (settlementCents / 100).toFixed(2),
      })),
    };
    this.current = nextLadderEvent();
    this.events = [
      ...this.events.map((event) => (event.ticker === old.ticker ? settled : event)),
      this.current,
    ];
  }

  override async listLadders(): Promise<LadderListing[]> {
    const listed = await super.listLadders();
    if (this.current.ticker === LADDER_TICKER) return listed;
    // The expired ladder is no longer listed; the next weekly one is.
    return listed.map((listing) =>
      listing.eventTicker === LADDER_TICKER
        ? {
            ...listing,
            eventTicker: this.current.ticker,
            title: this.current.title,
            expiry: this.current.expiry ?? NEXT_EXPIRY,
          }
        : listing,
    );
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

  /**
   * The ladder of `eventTicker` as Gemini quotes it now, for the console's cover (issue #97): no drift,
   * no call counted. Throws for an event Gemini does not list as a ladder (a settled one).
   */
  quote(eventTicker: string): Ladder {
    const event = this.events.find((candidate) => candidate.ticker === eventTicker);
    const ladder =
      event === undefined ? null : buildLadder(event, this.#spot(), { fetchedAt: new Date().toISOString() });
    if (ladder === null) throw new Error(`no ladder ${eventTicker}`);
    return ladder;
  }

  override async getLadder(): Promise<Ladder> {
    await super.getLadder();
    const ladder = buildLadder(this.current, this.#spot(), { fetchedAt: new Date().toISOString() });
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
  /** The executor: it fills approved intents and settles filled positions at expiry. */
  executor: Executor;
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
  /** The market data the MCP server reads, for example the real Gemini client on a fake Gemini. */
  marketsClient?: MarketsClient;
  /** A signal wallet for the MCP server, for example a fake with payments on record. None by default. */
  payments?: PaymentsClient;
  /** The MCP server's clock, for example one a test moves a day ahead. The system clock by default. */
  clock?: Clock;
  /** The console's public address, which links are built on. */
  consoleUrl?: string;
  /** More server settings, for example `MCP_TOOL_DEADLINE_MS`. */
  env?: Record<string, string>;
  logger?: Logger;
  /**
   * Runs before the console answers a request, for example to hold it as a slow console would. The
   * request's signal aborts when the caller gives up on it.
   */
  consoleGate?: (request: Request) => Promise<void>;
  /**
   * Runs before a JSON-RPC request from the MCP server reaches the chain, for example to hold every
   * `eth_getTransactionReceipt` as a stalled RPC endpoint would. `signal` aborts when the server gives
   * up on the request. Other clients (the executor, the test's reader) reach the chain directly.
   */
  rpcGate?: (methods: string[], signal: AbortSignal) => Promise<void>;
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

    const consoleToken = randomBytes(24).toString("base64url");
    const fake = createFakeConsole({
      token: consoleToken,
      ...(options.consoleUrl === undefined ? {} : { publicUrl: options.consoleUrl }),
      holdings: options.holdings,
      isContractAgent: async (address) =>
        (await reader.getRoles()).agent.toLowerCase() === address.toLowerCase(),
      executorAddress: devAccount("executor").address,
      // The cover the console measures on Gemini's quotes and the chain's intents (issue #97).
      cover: coverFromPlans({
        // The fixture's ladders expire on fixed dates: measure as if an hour before the current one's
        // expiry, whenever the test runs, and after any ladder `expire` settled.
        now: () => {
          const before = Math.min(Date.now(), Date.parse(markets.current.expiry ?? EXPIRY) - 3_600_000);
          const settled = markets.events
            .filter((event) => event.status === "settled")
            .map((event) => Date.parse(event.expiry ?? EXPIRY) + 60_000);
          return new Date(Math.max(before, ...settled));
        },
        ladder: (_asset, eventTicker) => Promise.resolve(markets.quote(eventTicker)),
        intents: async () => {
          const count = await reader.getIntentCount();
          const read = await Promise.all(Array.from({ length: count }, (_, id) => reader.getIntent(id)));
          return read.filter((intent): intent is Intent => intent !== null);
        },
      }),
    });
    const gate = options.consoleGate;
    const consoleHttp = await listen(
      gate === undefined
        ? fake.fetch
        : async (request) => {
            await gate(request);
            return fake.fetch(request);
          },
    );
    servers.push(consoleHttp.server);

    // The executor reads outcomes from the same markets the agent plans on, and records settlements in
    // the console over HTTP, as on the hosted stack.
    executor = startExecutor({
      client: devPolicyClient(chain.rpcUrl, policy, "executor"),
      venue: simulatedVenue(markets),
      settlements: consoleSettlementSink({ consoleUrl: consoleHttp.url }),
      fromBlock: chain.deployment.blockNumber,
      fillDelayMs: 0,
      pollingIntervalMs: 100,
      settleIntervalMs: 200,
      // Ask about open markets on every pass, and again 200 ms after an unpublished outcome: the test
      // moves the ladder past expiry whenever it likes.
      openRecheckMs: 0,
      settleBackoffMs: [200],
      log: () => undefined,
    });

    let agentRpcUrl = chain.rpcUrl;
    const rpcGate = options.rpcGate;
    if (rpcGate !== undefined) {
      const proxy = await listen(async (request) => {
        const body = await request.text();
        const parsed = JSON.parse(body) as { method: string } | { method: string }[];
        await rpcGate(
          (Array.isArray(parsed) ? parsed : [parsed]).map((call) => call.method),
          request.signal,
        );
        const answer = await fetch(chain.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        return new Response(await answer.text(), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      });
      servers.push(proxy.server);
      agentRpcUrl = proxy.url;
    }

    const mcpToken = randomBytes(32).toString("base64url");
    const server = createMandateServer(
      parseConfig({
        MCP_AUTH_TOKEN: mcpToken,
        MCP_HOST: "127.0.0.1",
        ARC_RPC_URL: agentRpcUrl,
        POLICY_ADDRESS: policy,
        POLICY_DEPLOY_BLOCK: chain.deployment.blockNumber.toString(),
        AGENT_PRIVATE_KEY: devPrivateKey("agent"),
        CONSOLE_URL: consoleHttp.url,
        CONSOLE_SERVICE_TOKEN: consoleToken,
        ...options.env,
      }),
      options.logger ?? silentLogger,
      {
        services: {
          markets: options.marketsClient ?? markets,
          ...(options.payments === undefined ? {} : { payments: options.payments }),
        },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      },
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
      executor: running,
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
