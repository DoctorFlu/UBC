import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { verifyHedgeSignal } from "@mandate/shared";
import { recordedSignalsApp } from "@mandate/signals/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { X402Buyer } from "../src/x402/buyer";
import { SignalPayments } from "../src/x402/payments";
import { SignalStore } from "../src/x402/signal-store";
import { SpendLedger } from "../src/x402/spend-ledger";
import { connectClient, TEST_BUYER_ADDRESS, TEST_BUYER_KEY, testServer } from "./helpers";

const SIGNALS_URL = "http://signals.test";
const DAY = "2026-11-15";

/**
 * The real tool, payments service, x402 buyer and Circle GatewayClient (throwaway key, never funded)
 * buying from the real signal API on recorded Gemini data with a fake Gateway facilitator.
 * Global fetch is routed into the signal API, so nothing leaves the process.
 */
async function setup(
  options: { dailyBudget?: bigint; maxPrice?: bigint; priceUsd?: string; dataDir?: string } = {},
) {
  const seller = recordedSignalsApp({ priceUsd: options.priceUsd ?? "0.0005" });
  const seen: { url: string; paymentSignature: string | null }[] = [];
  const network = { down: false };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, paymentSignature: request.headers.get("payment-signature") });
    if (network.down) throw new TypeError("fetch failed");
    return seller.app.fetch(request);
  });
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_BUYER_KEY });
  const sign = vi.spyOn(client.account, "signTypedData");
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "mandate-signals-"));
  const ledger = SpendLedger.open(join(dataDir, "signal-spend.jsonl"));
  const payments = new SignalPayments({
    buyer: new X402Buyer(client),
    ledger,
    store: SignalStore.open(join(dataDir, "signals")),
    signalsUrl: SIGNALS_URL,
    dailyBudget: options.dailyBudget ?? 1_000n,
    maxPrice: options.maxPrice ?? 500n,
  });
  const mcp = await connectClient(testServer({ services: { payments } }));
  const buy = async (args: Record<string, unknown> = { asset: "BTC" }) => {
    const result = await mcp.callTool({ name: "buy_signal", arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    return {
      isError: result.isError === true,
      structured: result.structuredContent as Record<string, unknown> & {
        status: string;
        reasons: { code: string; message: string }[];
        nextAction?: { actor: string; hint: string };
        receiptId: string | null;
        budget: { dailyUsdc: string; spentTodayUsdc: string; remainingUsdc: string; resetsAt: string };
        signal: { strikes: unknown[]; eventTicker: string; counts: Record<string, number> } | null;
      },
      text: content?.[0]?.text ?? "",
    };
  };
  return { seller, seen, network, sign, dataDir, ledger, payments, buy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buy_signal", () => {
  it("pays from the Gateway balance and returns a compact signal with its receipt id", async () => {
    const { buy, sign, seen, seller, payments } = await setup();

    const { isError, structured, text } = await buy();

    expect(isError).toBe(false);
    expect(structured).toMatchObject({
      status: "approved",
      reasons: [],
      priceUsdc: "0.0005",
      budget: {
        dailyUsdc: "0.001",
        spentTodayUsdc: "0.0005",
        remainingUsdc: "0.0005",
        resetsAt: "2026-11-16T00:00:00.000Z",
      },
      nextAction: { actor: "agent" },
    });
    expect(structured.receiptId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(structured.nextAction?.hint).toContain(structured.receiptId);
    expect(structured.signal).toMatchObject({ eventTicker: "BTC2611202200", horizon: "weekly" });
    expect(structured.signal?.strikes).toHaveLength(21);
    expect(text).toMatch(/^Bought the BTC weekly hedge signal for 0\.0005 USDC \(receipt 0x[0-9a-f]{64}\)\./);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(seen.map((r) => r.paymentSignature === null)).toEqual([true, true, false]);
    expect(seller.facilitator.settleCalls).toHaveLength(1);
    const settled = seller.facilitator.settleCalls[0]?.payload.payload.authorization as { nonce: string };
    expect(settled.nonce).toBe(structured.receiptId);

    const stored = payments.purchasedSignal(structured.receiptId ?? "");
    expect(stored?.receipt).toMatchObject({ amount: "500", payer: TEST_BUYER_ADDRESS });
    expect(stored && verifyHedgeSignal(stored.signal)).toBe(true);
    expect(stored?.signal.signalId).toBe(structured["signalId"]);
  });

  it("refuses a request beyond the daily budget before any signature is produced", async () => {
    const { buy, sign, seen, seller, ledger } = await setup({ dailyBudget: 700n });

    expect((await buy()).structured.status).toBe("approved");
    expect(sign).toHaveBeenCalledTimes(1);
    const before = seen.length;

    const { isError, structured, text } = await buy();

    expect(isError).toBe(false);
    expect(structured).toMatchObject({
      status: "rejected",
      reasons: [{ code: "SIGNAL_BUDGET_EXHAUSTED" }],
      receiptId: null,
      signal: null,
      priceUsdc: "0.0005",
      budget: { spentTodayUsdc: "0.0005", remainingUsdc: "0.0002" },
      nextAction: { actor: "agent" },
    });
    expect(text).toContain("cannot cover a 0.0005 USDC signal");
    expect(sign).toHaveBeenCalledTimes(1);
    // Only the free price check went out, without a payment.
    expect(seen.slice(before)).toEqual([expect.objectContaining({ paymentSignature: null })]);
    expect(seller.facilitator.verifyCalls).toHaveLength(1);
    expect(ledger.spentOn(DAY)).toBe(500n);
  });

  it("does not even ask the seller once the budget is used up", async () => {
    const { buy, sign, seen } = await setup({ dailyBudget: 500n });
    await buy();
    const before = seen.length;

    const { structured } = await buy();

    expect(structured).toMatchObject({
      status: "rejected",
      reasons: [{ code: "SIGNAL_BUDGET_EXHAUSTED" }],
      priceUsdc: null,
      budget: { remainingUsdc: "0" },
    });
    expect(seen).toHaveLength(before);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("lets only as many concurrent purchases through as the budget covers", async () => {
    const { buy, sign, seller } = await setup({ dailyBudget: 1_000n });

    const results = await Promise.all([buy(), buy(), buy()]);

    const statuses = results.map((r) => r.structured.status).sort();
    expect(statuses).toEqual(["approved", "approved", "rejected"]);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(seller.facilitator.settleCalls).toHaveLength(2);
  });

  it("keeps the day's spend and the purchased signals across a restart", async () => {
    const first = await setup({ dailyBudget: 500n });
    const { structured } = await first.buy();
    const receiptId = structured.receiptId ?? "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const second = await setup({ dailyBudget: 500n, dataDir: first.dataDir });
    expect(second.payments.budget(new Date(`${DAY}T13:00:00Z`))).toMatchObject({
      spent: 500n,
      remaining: 0n,
    });
    expect((await second.buy()).structured.reasons).toEqual([
      expect.objectContaining({ code: "SIGNAL_BUDGET_EXHAUSTED" }),
    ]);
    expect(second.seen).toHaveLength(0);
    expect(second.payments.purchasedSignal(receiptId)?.signal.eventTicker).toBe("BTC2611202200");
  });

  it("refuses a price above the per-signal maximum without signing or reserving", async () => {
    const { buy, sign, ledger } = await setup({ priceUsd: "0.0006", maxPrice: 500n });

    const { structured } = await buy();

    expect(structured).toMatchObject({
      status: "rejected",
      reasons: [{ code: "PRICE_ABOVE_MAXIMUM" }],
      priceUsdc: "0.0006",
      budget: { spentTodayUsdc: "0" },
    });
    expect(sign).not.toHaveBeenCalled();
    expect(ledger.entriesOn(DAY)).toHaveLength(0);
  });

  it("passes on a free refusal from the seller without paying", async () => {
    const { buy, sign, ledger } = await setup();

    const unknown = await buy({ asset: "DOGE" });
    expect(unknown.structured).toMatchObject({ status: "unavailable", reasons: [{ code: "UNKNOWN_ASSET" }] });
    const noLadder = await buy({ asset: "BTC", eventTicker: "BTC2611212200" });
    expect(noLadder.structured).toMatchObject({ status: "unavailable", reasons: [{ code: "NO_LADDER" }] });
    expect(noLadder.text).toContain("Nothing was paid.");

    expect(sign).not.toHaveBeenCalled();
    expect(ledger.entriesOn(DAY)).toHaveLength(0);
  });

  it("says when the signal API cannot be reached", async () => {
    const { buy, network, sign } = await setup();
    network.down = true;

    const { structured } = await buy();

    expect(structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "SIGNAL_API_UNREACHABLE" }],
      nextAction: { actor: "owner" },
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("releases the reservation when Gateway rejects the payment for lack of funds", async () => {
    const { buy, seller, ledger } = await setup();
    seller.facilitator.verifyResult = () => ({ isValid: false, invalidReason: "insufficient_balance" });

    const { structured } = await buy();

    expect(structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "INSUFFICIENT_GATEWAY_BALANCE" }],
      nextAction: { actor: "owner" },
      budget: { spentTodayUsdc: "0" },
    });
    expect(seller.facilitator.settleCalls).toHaveLength(0);
    expect(ledger.entriesOn(DAY).map((e) => e.status)).toEqual(["released"]);
  });

  it("rejects more than one way of picking the ladder", async () => {
    const { buy, sign } = await setup();

    const { isError, text } = await buy({ asset: "BTC", horizon: "weekly", eventTicker: "BTC2611202200" });

    expect(isError).toBe(true);
    expect(text).toMatch(/^INVALID_INPUT: /);
    expect(sign).not.toHaveBeenCalled();
  });

  it("is unavailable, not an error, when no buyer wallet is configured", async () => {
    const client = await connectClient(testServer());

    const result = await client.callTool({ name: "buy_signal", arguments: { asset: "BTC" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "NOT_CONFIGURED" }],
      nextAction: { actor: "owner" },
      receiptId: null,
    });
  });
});
