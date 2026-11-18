import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Category } from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FeedHealth } from "@/lib/live/types";

import { envSnapshot } from "../../test/support/accounts";
import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../test/support/devchain";
import { testConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";

const silent = { info: () => undefined, warn: () => undefined };

/**
 * Stands between the console and anvil like Arc's public RPC behind Cloudflare: it passes every request on
 * until told to refuse, then answers HTTP 429 "rate limit exceeded" with a `Retry-After`.
 */
class RateLimitingProxy {
  readonly server: Server;
  url = "";
  requests = 0;
  refuse = 0;
  retryAfter = "1";

  constructor(private readonly upstream: string) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        this.requests += 1;
        if (this.refuse > 0) {
          this.refuse -= 1;
          res.writeHead(429, { "content-type": "text/plain", "retry-after": this.retryAfter });
          res.end("rate limit exceeded");
          return;
        }
        void fetch(this.upstream, { method: "POST", headers: { "content-type": "application/json" }, body })
          .then(async (answer) => {
            res.writeHead(answer.status, { "content-type": "application/json" });
            res.end(await answer.text());
          })
          .catch(() => {
            res.writeHead(502);
            res.end();
          });
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe("ConsoleService when the RPC rate-limits it", () => {
  let chain: TestChain;
  let proxy: RateLimitingProxy;
  let service: ConsoleService;

  beforeAll(async () => {
    chain = await startTestChain({ contract: "production" });
    proxy = new RateLimitingProxy(chain.rpcUrl);
    await proxy.start();
    // The console reads the chain through the proxy; the test's own clients go straight to anvil.
    const dir = mkdtempSync(join(tmpdir(), "mandate-chain-"));
    const deploymentFile = join(dir, "deployment.json");
    const record = JSON.parse(readFileSync(chain.deploymentFile, "utf8")) as Record<string, unknown>;
    writeFileSync(deploymentFile, JSON.stringify({ ...record, rpcUrl: proxy.url }));
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    service = new ConsoleService(
      testConsoleConfig(dataDir, { publicUrl: "http://localhost:3000" }),
      openDatabase(dataDir),
      { env: { POLICY_DEPLOYMENT_FILE: deploymentFile }, logger: silent },
    );
    service.start();
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await proxy.stop();
    await chain.stop();
  });

  it("says the RPC is rate-limiting it, asks nothing until Retry-After, never reads as offline, and catches up", async () => {
    await expect.poll(() => envSnapshot(service).feed.health, { timeout: 15_000 }).toBe("live");

    // Every feed state the owner could see from here on.
    const seen = new Set<FeedHealth>();
    const details = new Set<string>();
    const watch = setInterval(() => {
      const { feed } = envSnapshot(service);
      seen.add(feed.health);
      details.add(feed.detail);
    }, 10);
    try {
      proxy.retryAfter = "2";
      proxy.refuse = 1;
      const intent = await chain.agent.proposeTrade({
        market: BTC_ABOVE_65K,
        category: Category.Crypto,
        outcome: "YES",
        isBuy: true,
        limitPrice: 65,
        amountCents: 1_000,
      });
      await expect
        .poll(() => envSnapshot(service).feed.detail, { timeout: 5_000, interval: 10 })
        .toMatch(/^The RPC is rate-limiting us; retrying in [23] s\./);
      expect(envSnapshot(service).feed.health).toBe("lagging");

      // The follower polls every 50 ms here: without the gate it would ask about twenty times a second.
      const refusedAt = proxy.requests;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(proxy.requests).toBe(refusedAt);

      // Recovers by itself, with the event that landed meanwhile.
      await expect
        .poll(() => envSnapshot(service).chain?.intents.some((row) => row.id === intent.intentId), {
          timeout: 10_000,
        })
        .toBe(true);
      await expect.poll(() => envSnapshot(service).feed.health, { timeout: 5_000 }).toBe("live");
    } finally {
      clearInterval(watch);
    }
    expect(seen.has("offline")).toBe(false);
    expect([...details].some((detail) => /Request exceeds defined limit/.test(detail))).toBe(false);
  });
});
