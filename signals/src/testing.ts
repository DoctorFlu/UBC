import { ARC_TESTNET } from "@mandate/shared";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";

/**
 * Offline stand-in for Circle Gateway's x402 facilitator.
 * `getSupported` returns the Arc testnet kind exactly as https://gateway-api-testnet.circle.com/v1/x402/supported
 * returned it on 2026-11-15; `verify` and `settle` record their calls and answer with what the test sets.
 */
export class FakeGatewayFacilitator implements FacilitatorClient {
  readonly verifyCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];
  readonly settleCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];

  constructor(
    public verifyResult: (payload: PaymentPayload) => VerifyResponse = (payload) => ({
      isValid: true,
      payer: payerOf(payload),
    }),
    public settleResult: (payload: PaymentPayload) => SettleResponse = (payload) => ({
      success: true,
      transaction: "fake-gateway-transfer",
      network: ARC_TESTNET.network,
      payer: payerOf(payload),
    }),
  ) {}

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls.push({ payload, requirements });
    return Promise.resolve(this.verifyResult(payload));
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls.push({ payload, requirements });
    return Promise.resolve(this.settleResult(payload));
  }

  getSupported() {
    return Promise.resolve({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: ARC_TESTNET.network,
          extra: {
            name: "GatewayWalletBatched",
            version: "1",
            verifyingContract: ARC_TESTNET.gatewayWallet.toLowerCase(),
            minValiditySeconds: 604800,
            assets: [
              { symbol: "USDC", address: ARC_TESTNET.usdc, decimals: 6, authorizationVersions: ["1", "2"] },
            ],
          },
        },
      ],
      extensions: [],
      signers: { "eip155:*": [] },
    } as Awaited<ReturnType<FacilitatorClient["getSupported"]>>);
  }
}

function payerOf(payload: PaymentPayload): string {
  const authorization = payload.payload.authorization as { from?: unknown } | undefined;
  return typeof authorization?.from === "string" ? authorization.from : "";
}
