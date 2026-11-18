import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPublicClient } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  HeadCache,
  PolicyClient,
  RATE_LIMIT_FIRST_BACKOFF_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  RpcGate,
  RpcRateLimitedError,
  devchain,
  parseRetryAfter,
  politeHttp,
  rateLimitOf,
  rpcErrorText,
} from "../src";

/**
 * A JSON-RPC endpoint that answers like a node and, on demand, refuses like Arc's public RPC behind
 * Cloudflare: HTTP 429, "rate limit exceeded", with a `Retry-After` when told to send one.
 */
class StubRpc {
  server: Server;
  url = "";
  /** Requests that reached the endpoint, refused or not. */
  requests = 0;
  methods: string[] = [];
  /** The next this many requests are refused. */
  refuse = 0;
  retryAfter: string | null = null;
  block = 100n;

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        this.requests += 1;
        const parsed = JSON.parse(body) as { id: number; method: string } | { id: number; method: string }[];
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        this.methods.push(...calls.map((call) => call.method));
        if (this.refuse > 0) {
          this.refuse -= 1;
          res.writeHead(429, {
            "content-type": "text/plain",
            ...(this.retryAfter === null ? {} : { "retry-after": this.retryAfter }),
          });
          res.end("rate limit exceeded");
          return;
        }
        const answers = calls.map((call) => ({
          jsonrpc: "2.0",
          id: call.id,
          result: this.answer(call.method),
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
      });
    });
  }

  private answer(method: string): unknown {
    switch (method) {
      case "eth_chainId":
        return `0x${devchain.id.toString(16)}`;
      case "eth_blockNumber":
        this.block += 1n;
        return `0x${this.block.toString(16)}`;
      case "eth_getLogs":
        return [];
      case "eth_sendRawTransaction":
        return `0x${"ab".repeat(32)}`;
      default:
        return null;
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  reset(): void {
    this.requests = 0;
    this.methods = [];
    this.refuse = 0;
    this.retryAfter = null;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

const rpc = new StubRpc();

beforeAll(async () => {
  await rpc.start();
});

afterAll(async () => {
  await rpc.stop();
});

beforeEach(() => {
  rpc.reset();
});

function client(gate: RpcGate, options: { maxWaitMs?: number; retryCount?: number } = {}) {
  return createPublicClient({
    chain: devchain,
    transport: politeHttp(rpc.url, { gate, ...options }),
  });
}

describe("rateLimitOf", () => {
  it("finds an HTTP 429 inside viem's error, with the endpoint's Retry-After", async () => {
    rpc.refuse = 1;
    rpc.retryAfter = "7";
    const error = await client(new RpcGate())
      .getBlockNumber({ cacheTime: 0 })
      .catch((e: unknown) => e);
    expect(rateLimitOf(error)).toEqual({ retryAfterMs: 7_000 });
    // The log line names the refusal and never the endpoint's URL or the request body.
    const text = rpcErrorText(error);
    expect(text).toBe("the RPC is rate-limiting us (HTTP 429, retry after 7 s)");
    expect(text).not.toContain("127.0.0.1");
  });

  it("knows -32005 without an HTTP status, and leaves other errors alone", () => {
    expect(rateLimitOf({ code: -32005, message: "Request exceeds defined limit." })).toEqual({
      retryAfterMs: null,
    });
    expect(rateLimitOf(new Error("wrapped", { cause: { code: -32007 } }))).toEqual({ retryAfterMs: null });
    expect(rateLimitOf(new RpcRateLimitedError(3_000))).toEqual({ retryAfterMs: 3_000 });
    expect(rateLimitOf({ code: -32012, message: "requested range too large" })).toBeNull();
    expect(rateLimitOf(new Error("fetch failed"))).toBeNull();
  });

  it("reads Retry-After as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-11-18T03:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter("Wed, 18 Nov 2026 03:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Wed, 18 Nov 2026 02:59:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("RpcGate", () => {
  it("doubles the wait with each refusal in a row, jittered up to a fifth, and starts over after an answer", () => {
    let now = 0;
    let random = 0;
    const gate = new RpcGate({ now: () => now, random: () => random });
    expect(gate.refused(null)).toBe(RATE_LIMIT_FIRST_BACKOFF_MS);
    now += 10_000;
    expect(gate.refused(null)).toBe(RATE_LIMIT_FIRST_BACKOFF_MS * 2);
    now += 10_000;
    random = 0.999;
    const third = gate.refused(null);
    expect(third).toBeGreaterThan(RATE_LIMIT_FIRST_BACKOFF_MS * 4);
    expect(third).toBeLessThanOrEqual(RATE_LIMIT_FIRST_BACKOFF_MS * 4 * 1.2);
    now += 60_000;
    gate.answered();
    random = 0;
    expect(gate.refused(null)).toBe(RATE_LIMIT_FIRST_BACKOFF_MS);
  });

  it("counts refusals of requests sent together as one, honours Retry-After, and caps every wait", () => {
    let now = 0;
    const gate = new RpcGate({ now: () => now, random: () => 0 });
    gate.refused(null);
    gate.refused(null);
    gate.refused(null);
    expect(gate.streak).toBe(1);
    now += 5_000;
    expect(gate.refused(9_000)).toBe(9_000);
    now += 10_000;
    expect(gate.refused(3_600_000)).toBe(RATE_LIMIT_MAX_BACKOFF_MS);
  });
});

describe("politeHttp", () => {
  it("sends nothing while the gate is closed: the request fails at once, saying when to retry", async () => {
    const gate = new RpcGate();
    const reader = client(gate);
    rpc.refuse = 1;
    rpc.retryAfter = "30";
    await expect(reader.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(rpc.requests).toBe(1);

    const error = await reader.getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(rateLimitOf(error)?.retryAfterMs).toBeGreaterThan(29_000);
    expect((error as Error).message).toContain("The RPC is rate-limiting us; retrying in 3");
    // The endpoint never saw the second request.
    expect(rpc.requests).toBe(1);
  });

  it("waits for Retry-After and sends the request again, once, when the caller may wait", async () => {
    const gate = new RpcGate();
    const reader = client(gate, { maxWaitMs: 5_000, retryCount: 1 });
    rpc.refuse = 1;
    rpc.retryAfter = "1";
    const started = Date.now();
    const block = await reader.getBlockNumber({ cacheTime: 0 });
    expect(block).toBeGreaterThan(100n);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(rpc.requests).toBe(2);
    expect(gate.streak).toBe(0);
  });

  it("sends a refused transaction again (a 429 proves it was not taken), and only then", async () => {
    const gate = new RpcGate();
    const writer = client(gate, { maxWaitMs: 5_000, retryCount: 2 });
    rpc.refuse = 1;
    rpc.retryAfter = "1";
    const hash = await writer.request({
      method: "eth_sendRawTransaction",
      params: ["0x02"],
    });
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(rpc.methods).toEqual(["eth_sendRawTransaction", "eth_sendRawTransaction"]);
  });
});

describe("PolicyClient.watchEvents under a rate limit", () => {
  it("backs off for the endpoint's Retry-After, asks nothing meanwhile, and recovers without a restart", async () => {
    const gate = new RpcGate();
    const publicClient = client(gate);
    const policy = new PolicyClient({ address: "0x0000000000000000000000000000000000000001", publicClient });
    const errors: { retryInMs: number | undefined; at: number }[] = [];
    let polls = 0;
    let refusedAt = 0;
    const stop = policy.watchEvents({
      pollingIntervalMs: 50,
      gate,
      onEvents: () => undefined,
      onPolled: () => {
        polls += 1;
        if (polls === 3) {
          // From here the endpoint refuses the next request and asks for a second's rest.
          rpc.refuse = 1;
          rpc.retryAfter = "1";
          refusedAt = rpc.requests;
        }
      },
      onError: (_error, retryInMs) => {
        errors.push({ retryInMs, at: Date.now() });
      },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (polls < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      stop();
    }
    expect(polls).toBeGreaterThanOrEqual(6);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.retryInMs).toBeGreaterThanOrEqual(1_000);
    // One refused request, then the next poll only after the wait: polling every 50 ms would have sent
    // about twenty in that second.
    const methodsAfterRefusal = rpc.methods.slice(refusedAt);
    expect(methodsAfterRefusal[0]).toBe("eth_blockNumber");
    expect(rpc.requests - refusedAt).toBeLessThanOrEqual(1 + 2 * 4);
  });
});

describe("HeadCache", () => {
  it("reads the head once per interval for every poller, and never goes back", async () => {
    let now = 0;
    let reads = 0;
    let next = 10n;
    const cache = new HeadCache(
      () => {
        reads += 1;
        return Promise.resolve({ number: next, timestamp: 0n });
      },
      () => now,
    );
    const [a, b] = await Promise.all([cache.latest(1_000), cache.latest(1_000)]);
    expect(a.number).toBe(10n);
    expect(b.number).toBe(10n);
    expect(reads).toBe(1);
    now += 500;
    expect((await cache.latest(1_000)).number).toBe(10n);
    expect(reads).toBe(1);
    now += 600;
    next = 9n; // a node behind a load balancer answers with an older block
    expect((await cache.latest(1_000)).number).toBe(10n);
    expect(reads).toBe(2);
  });
});
