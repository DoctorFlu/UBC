import { GatewayClient, type Balances, type DepositResult } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET } from "@mandate/shared";
import { createSignalsApp } from "@mandate/signals";
import { FakeGatewayFacilitator } from "@mandate/signals/testing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InsufficientWalletBalanceError,
  PaymentRejectedError,
  PriceAboveMaximumError,
  X402Buyer,
  type GatewayBuyerClient,
} from "../src/x402/buyer";

const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const HELLO_URL = "http://signals.test/v1/signal/hello";

/**
 * Real GatewayClient (throwaway key, never funded) talking to the real signals app with a fake facilitator.
 * Global fetch is routed into the app, so nothing leaves the process.
 */
function setup() {
  const facilitator = new FakeGatewayFacilitator();
  const app = createSignalsApp({ sellerAddress: SELLER, facilitator });
  const seen: { url: string; paymentSignature: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, paymentSignature: request.headers.get("payment-signature") });
    return app.fetch(request);
  });
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: generatePrivateKey() });
  const sign = vi.spyOn(client.account, "signTypedData");
  return { facilitator, seen, client, sign, buyer: new X402Buyer(client) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("X402Buyer.pay", () => {
  it("refuses a price above the per-call maximum before signing anything", async () => {
    const { buyer, sign, seen, facilitator } = setup();

    const attempt = buyer.pay(HELLO_URL, { maxPrice: "0.0005" });
    await expect(attempt).rejects.toBeInstanceOf(PriceAboveMaximumError);
    await expect(attempt).rejects.toMatchObject({ requested: 1000n, maximum: 500n });

    expect(sign).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.paymentSignature).toBeNull();
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("pays at or under the maximum and returns a typed receipt", async () => {
    const { buyer, client, sign, seen, facilitator } = setup();

    const paid = await buyer.pay<{ message: string }>(HELLO_URL, { maxPrice: "0.001" });

    expect(paid.status).toBe(200);
    expect(paid.data.message).toBe("hello from @mandate/signals");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(seen.map((r) => r.paymentSignature === null)).toEqual([true, false]);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(paid.receipt).toMatchObject({
      url: HELLO_URL,
      amount: "1000",
      amountUsdc: "0.001",
      asset: ARC_TESTNET.usdc,
      payer: client.address,
      payee: SELLER,
      network: "eip155:5042002",
      settlementId: "fake-gateway-transfer",
    });
    expect(paid.receipt?.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const validFor = Number(paid.receipt?.validBefore) - Date.now() / 1000;
    expect(validFor).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(Number.isNaN(Date.parse(paid.receipt?.paidAt ?? ""))).toBe(false);
  });

  it("surfaces the facilitator's rejection reason", async () => {
    const { buyer, facilitator } = setup();
    facilitator.verifyResult = () => ({ isValid: false, invalidReason: "insufficient_balance" });

    const attempt = buyer.pay(HELLO_URL, { maxPrice: "0.001" });
    await expect(attempt).rejects.toBeInstanceOf(PaymentRejectedError);
    await expect(attempt).rejects.toMatchObject({ reason: "insufficient_balance" });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("surfaces a settlement failure reported in PAYMENT-RESPONSE", async () => {
    const { buyer, facilitator } = setup();
    facilitator.settleResult = () => ({
      success: false,
      errorReason: "insufficient_balance",
      transaction: "",
      network: ARC_TESTNET.network,
    });

    await expect(buyer.pay(HELLO_URL, { maxPrice: "0.001" })).rejects.toMatchObject({
      name: "PaymentRejectedError",
      reason: "insufficient_balance",
    });
  });

  it("keeps per-call maximums separate when calls overlap", async () => {
    const { buyer } = setup();

    const [cheap, enough] = await Promise.allSettled([
      buyer.pay(HELLO_URL, { maxPrice: "0.0001" }),
      buyer.pay(HELLO_URL, { maxPrice: "0.01" }),
    ]);

    expect(cheap.status).toBe("rejected");
    expect(enough.status).toBe("fulfilled");
  });
});

describe("X402Buyer.ensureDeposit", () => {
  function fakeClient(state: { wallet: bigint; gateway: bigint; creditAfterPolls?: number }) {
    let polls = 0;
    let pendingCredit: (() => void) | undefined;
    const deposit = vi.fn((amount: string): Promise<DepositResult> => {
      const value = BigInt(Math.round(Number(amount) * 1e6));
      state.wallet -= value;
      polls = 0;
      const credit = () => {
        state.gateway += value;
      };
      if (!state.creditAfterPolls) credit();
      else pendingCredit = credit;
      return Promise.resolve({
        depositTxHash: "0xdead",
        amount: value,
        formattedAmount: amount,
        depositor: "0x0000000000000000000000000000000000000001",
      });
    });
    const balances = (): Balances => ({
      wallet: { balance: state.wallet, formatted: "" },
      gateway: {
        total: state.gateway,
        available: state.gateway,
        withdrawing: 0n,
        withdrawable: 0n,
        formattedTotal: "",
        formattedAvailable: "",
        formattedWithdrawing: "",
        formattedWithdrawable: "",
      },
    });
    const client: GatewayBuyerClient = {
      address: "0x0000000000000000000000000000000000000001",
      getBalances: () => {
        polls += 1;
        if (pendingCredit && state.creditAfterPolls !== undefined && polls > state.creditAfterPolls) {
          pendingCredit();
          pendingCredit = undefined;
        }
        return Promise.resolve(balances());
      },
      deposit,
      pay: () => Promise.reject(new Error("not used")),
      searchTransfers: () => Promise.resolve({ transfers: [] }),
      onBeforePaymentCreation: () => undefined,
      onAfterPaymentCreation: () => undefined,
      onPaymentResponse: () => undefined,
    };
    return { client, deposit };
  }

  it("does nothing when the Gateway balance already covers the minimum", async () => {
    const { client, deposit } = fakeClient({ wallet: 0n, gateway: 50_000n });
    const result = await new X402Buyer(client).ensureDeposit({ minAvailable: "0.01", depositAmount: "1" });
    expect(result).toEqual({ deposited: false, available: 50_000n });
    expect(deposit).not.toHaveBeenCalled();
  });

  it("deposits and waits until Gateway credits the balance", async () => {
    const { client, deposit } = fakeClient({ wallet: 5_000_000n, gateway: 0n, creditAfterPolls: 2 });
    const result = await new X402Buyer(client).ensureDeposit({
      minAvailable: "0.01",
      depositAmount: "1",
      pollMs: 1,
    });
    expect(deposit).toHaveBeenCalledWith("1");
    expect(result).toMatchObject({ deposited: true, available: 1_000_000n, depositTxHash: "0xdead" });
  });

  it("refuses to deposit more than the wallet holds, naming the address to fund", async () => {
    const { client, deposit } = fakeClient({ wallet: 500_000n, gateway: 0n });
    await expect(
      new X402Buyer(client).ensureDeposit({ minAvailable: "0.01", depositAmount: "1" }),
    ).rejects.toBeInstanceOf(InsufficientWalletBalanceError);
    expect(deposit).not.toHaveBeenCalled();
  });
});
