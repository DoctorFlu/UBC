/**
 * `PolicyClient.proposeTrade` under a caller's deadline (issue #105), on a real anvil: a proposal can
 * be stopped up to the moment it is broadcast, never after, and stopping one never breaks the next.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Category, type TradeIntentInput } from "@mandate/shared";
import { DEMO_POLICY } from "../src";
import { deployTestPolicy, startTestAnvil, type TestAnvil, type TestPolicy } from "./harness";

const trade: TradeIntentInput = {
  market: "GEMI-BTC2611202200-HI65000",
  category: Category.Crypto,
  outcome: "NO",
  isBuy: true,
  amountCents: 1_000,
  limitPrice: 30,
};

describe("proposeTrade with write options", () => {
  let anvil: TestAnvil;
  let chain: TestPolicy;

  beforeAll(async () => {
    anvil = await startTestAnvil();
  });
  afterAll(async () => {
    await anvil.stop();
  });
  beforeEach(async () => {
    chain = await deployTestPolicy(anvil, "production");
    await chain.user.setPolicy(DEMO_POLICY);
  });

  it("sends nothing when the check right before the broadcast refuses, and the next proposal works", async () => {
    const refusal = new Error("too little time left");
    await expect(
      chain.agent.proposeTrade(trade, {
        beforeBroadcast: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(await chain.outsider.getIntentCount()).toBe(0);
    // The signed transaction was never sent, so its nonce is still free.
    await expect(chain.agent.proposeTrade(trade)).resolves.toMatchObject({
      intentId: 0,
      verdict: "approved",
    });
  });

  it("sends nothing for a signal that has already aborted", async () => {
    const stop = new AbortController();
    stop.abort(new Error("deadline"));
    await expect(chain.agent.proposeTrade(trade, { signal: stop.signal })).rejects.toThrow("deadline");
    expect(await chain.outsider.getIntentCount()).toBe(0);
  });

  it("follows a broadcast proposal to its receipt even when the signal aborts right after", async () => {
    const stop = new AbortController();
    const result = await chain.agent.proposeTrade(trade, {
      signal: stop.signal,
      beforeBroadcast: () => {
        stop.abort(new Error("deadline"));
      },
    });
    expect(result).toMatchObject({ intentId: 0, verdict: "approved" });
    expect(await chain.outsider.getIntentCount()).toBe(1);
  });

  it("a proposal queued behind another is dropped when its signal aborts, without breaking the queue", async () => {
    const stop = new AbortController();
    const first = chain.agent.proposeTrade(trade);
    // Writes from one client run one at a time: this one waits until the first is done.
    const queued = chain.agent.proposeTrade({ ...trade, amountCents: 2_000 }, { signal: stop.signal });
    stop.abort(new Error("deadline"));
    await expect(queued).rejects.toThrow("deadline");
    await expect(first).resolves.toMatchObject({ intentId: 0 });
    await expect(chain.agent.proposeTrade(trade)).resolves.toMatchObject({ intentId: 1 });
    const second = await chain.outsider.getIntent(1);
    expect(second?.amountCents).toBe(1_000);
    expect(await chain.outsider.getIntentCount()).toBe(2);
  });
});
