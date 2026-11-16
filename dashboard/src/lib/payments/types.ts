/**
 * The agent's x402 signal payments as the console stores and shows them (issue #22). The MCP server
 * reports them through PUT /api/agent/v1/signal-payments/<receiptId> and /signal-budget; amounts stay
 * USDC atomic units in decimal strings all the way to the screen.
 */
import type { PutSignalBudgetRequest, PutSignalPaymentRequest } from "@mandate/shared";

/** One payment, first write wins. `receiptId` is lower case. */
export interface SignalPaymentView extends PutSignalPaymentRequest {
  receiptId: string;
  /** When the console first recorded it. */
  recordedAt: string;
}

/** The budget snapshot with the latest `asOf` the console has seen. */
export interface SignalBudgetView extends PutSignalBudgetRequest {
  storedAt: string;
}
