/**
 * Typed mock data for the console. Every view reads from here until its issue replaces it:
 * the event store and live feed (#14), policy editor (#15), activity (#16), hedge (#17),
 * audit (#18), payments (#22), backtest (#35), change requests (#36), scorecard (#38).
 *
 * Replace an export with a real source and delete it here; do not add data logic to this file.
 * The numbers are self-consistent: a BTC holding hedged with a ladder of "BTC below" contracts.
 */
import type {
  Agent,
  AuditRecord,
  ChangeRequest,
  HedgePlan,
  Holding,
  Intent,
  LadderRung,
  LiveStatus,
  Mandate,
  MandateUsage,
  Market,
  Payment,
  SetupStep,
} from "@/lib/domain";

/** Anvil account #0, the dev signer's owner address (a public test key; see lib/wallet/dev-signer.ts). */
export const OWNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/** Anvil account #1, standing in for Grok Bot's agent key. */
export const AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const POLICY_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const agent: Agent = {
  name: "Grok Bot",
  address: AGENT_ADDRESS,
  owner: OWNER_ADDRESS,
  pairedAt: "2026-11-15T13:21:40.000Z",
};

export const mandate: Mandate = {
  version: 3,
  totalBudgetCents: 100_000,
  maxOrderCents: 5_000,
  approvalThresholdCents: 2_500,
  dailyLossLimitCents: 5_000,
  allowedCategories: ["crypto", "macro"],
  paused: false,
  updatedAt: "2026-11-15T13:30:05.000Z",
  updateTx: "0xa365981777eab752aedbcf3615e54bd596b1b2ef097c44e288e52458a2ad95fd",
};

export const usage: MandateUsage = {
  budgetUsedCents: 41_250,
  dailyLossCents: 1_820,
  largestOrderTodayCents: 2_880,
  heldToday: 2,
  tripsToday: { MAX_ORDER_SIZE: 1, CATEGORY_NOT_ALLOWED: 1 },
};

export const liveStatus: LiveStatus = { source: "poller", lastEventAt: "2026-11-15T14:05:40.000Z" };

const btcBelow = (strike: number): Market => ({
  symbol: `BTC-B${strike / 1000}K-DEC26`,
  title: `BTC below $${(strike / 1000).toString()},000 on Dec 31`,
  category: "crypto",
});

export const intents: readonly Intent[] = [
  {
    id: "int-0007",
    createdAt: "2026-11-15T14:05:40.000Z",
    market: { symbol: "NBA-LAL-W-1116", title: "Lakers win on Nov 16", category: "sports" },
    side: "buy",
    contracts: 30,
    limitPriceCents: 52,
    notionalCents: 1_560,
    status: "rejected",
    reasonCode: "CATEGORY_NOT_ALLOWED",
    rationale: "Tried a sports market outside the mandate.",
    txHash: "0x75b678e3e99bf4e6a2cf62cc21d5445bff26abc81a492dfa8c422100853148e5",
    blockNumber: 18_204_771,
  },
  {
    id: "int-0006",
    createdAt: "2026-11-15T14:03:02.000Z",
    market: { symbol: "FED-CUT-DEC26", title: "Fed cuts rates in December", category: "macro" },
    side: "buy",
    contracts: 200,
    limitPriceCents: 31,
    notionalCents: 6_200,
    status: "rejected",
    reasonCode: "MAX_ORDER_SIZE",
    rationale: "Rate cut would soften a BTC drawdown; sized too large for one order.",
    txHash: "0xa59fcc0644d78f18e91dc798273d64f63d1f7f328f6d0a7ca66ccfb6fd35a963",
    blockNumber: 18_204_702,
  },
  {
    id: "int-0005",
    createdAt: "2026-11-15T14:02:19.000Z",
    market: btcBelow(80_000),
    side: "buy",
    contracts: 120,
    limitPriceCents: 24,
    notionalCents: 2_880,
    status: "held",
    reasonCode: "ABOVE_APPROVAL_THRESHOLD",
    rationale: "Deepest rung of the ladder; covers a fall below $80,000.",
    txHash: "0x25a8148bde19be4fcdc3fc46a5a33722c7a0407ca2a5a1df621d1b851422f3ec",
    blockNumber: 18_204_688,
  },
  {
    id: "int-0004",
    createdAt: "2026-11-15T14:02:14.000Z",
    market: btcBelow(85_000),
    side: "buy",
    contracts: 60,
    limitPriceCents: 22,
    notionalCents: 1_320,
    status: "filled",
    rationale: "Middle rung of the ladder.",
    txHash: "0xd332fdaca9ea2ed7209ec60af0d3eeccdecee19e51d668c7c024b0ef70a6c021",
    blockNumber: 18_204_685,
  },
  {
    id: "int-0003",
    createdAt: "2026-11-15T14:02:11.000Z",
    market: btcBelow(90_000),
    side: "buy",
    contracts: 40,
    limitPriceCents: 31,
    notionalCents: 1_240,
    status: "filled",
    rationale: "First rung of the ladder, nearest the spot price.",
    txHash: "0x2b22566f5704e361fd7c002a795b30df76a23971fd7bc997b1b3aefdfd9c8189",
    blockNumber: 18_204_683,
  },
  {
    id: "int-0002",
    createdAt: "2026-11-15T13:58:00.000Z",
    market: btcBelow(75_000),
    side: "buy",
    contracts: 50,
    limitPriceCents: 9,
    notionalCents: 450,
    status: "unfilled",
    rationale: "Tail rung; limit price below the best ask, so it did not fill.",
    txHash: "0xd1f6a887f16dda1d67e3503511038fc3e9fad838a1af2374bcc7144fd64808a6",
    blockNumber: 18_204_590,
  },
  {
    id: "int-0001",
    createdAt: "2026-11-15T13:41:27.000Z",
    market: { symbol: "ETH-B2800-DEC26", title: "ETH below $2,800 on Dec 31", category: "crypto" },
    side: "buy",
    contracts: 100,
    limitPriceCents: 27,
    notionalCents: 2_700,
    status: "held",
    reasonCode: "ABOVE_APPROVAL_THRESHOLD",
    rationale: "Cross-hedge: ETH tends to fall with BTC.",
    txHash: "0x06a86cec21155611859d483cd0dcdd170d75d3f1ce6d47b4e7fe43489cbbf25f",
    blockNumber: 18_204_402,
  },
];

export const holdings: readonly Holding[] = [
  { asset: "BTC", quantity: "0.5", priceCents: 9_225_000, valueCents: 4_612_500 },
];

export const ladder: readonly LadderRung[] = [
  { strike: 90_000, market: btcBelow(90_000), askCents: 31, plannedContracts: 40 },
  { strike: 85_000, market: btcBelow(85_000), askCents: 22, plannedContracts: 60 },
  { strike: 80_000, market: btcBelow(80_000), askCents: 24, plannedContracts: 120 },
  { strike: 75_000, market: btcBelow(75_000), askCents: 11, plannedContracts: 50 },
];

export const hedgePlan: HedgePlan = {
  // 40 × 31¢ + 60 × 22¢ + 120 × 24¢ + 50 × 11¢, the ladder below at its asks.
  costCents: 5_990,
  maxPayoutCents: 27_000,
  coveredBelowStrike: 90_000,
  notCovered: "A fall that stops above $90,000, and anything after Dec 31.",
};

export const payments: readonly Payment[] = [
  {
    id: "pay-0003",
    at: "2026-11-15T14:01:52.000Z",
    item: "BTC implied volatility, 30 day",
    provider: "signals.example",
    priceCents: 5,
    settlementTx: "0x4246bf7d9b5481255a9b0c8d9752e90fa5bbca7e8952be641682a71c9bb10dc3",
  },
  {
    id: "pay-0002",
    at: "2026-11-15T14:01:49.000Z",
    item: "Funding rates, top 5 venues",
    provider: "signals.example",
    priceCents: 3,
    settlementTx: "0xf2fa238b6083c1097c6904eadab5584ba62bca4c77df09489558e124266b3553",
  },
  {
    id: "pay-0001",
    at: "2026-11-15T13:57:31.000Z",
    item: "Gemini order book snapshot",
    provider: "signals.example",
    priceCents: 2,
    settlementTx: "0x2e957a3574673bec0d4111bdb00f5e3bba82da87adb315c06edcc6ad2a870c96",
  },
];

export const paymentsSummary = { spentTodayCents: 10, toolBudgetCents: 200, gatewayBalanceCents: 1_990 };

export const auditTrail: readonly AuditRecord[] = [
  ...intents.map((intent): AuditRecord => ({
    id: `audit-${intent.id}`,
    at: intent.createdAt,
    blockNumber: intent.blockNumber,
    txHash: intent.txHash,
    event:
      intent.status === "held"
        ? "IntentHeld"
        : intent.status === "rejected"
          ? "IntentRejected"
          : intent.status === "filled"
            ? "IntentFilled"
            : "IntentApproved",
    intentId: intent.id,
    status: intent.status,
    ...(intent.reasonCode ? { reasonCode: intent.reasonCode } : {}),
    summary: `${intent.side === "buy" ? "Buy" : "Sell"} ${intent.contracts.toString()} ${intent.market.title}`,
  })),
  {
    id: "audit-policy-3",
    at: mandate.updatedAt,
    blockNumber: 18_203_950,
    txHash: mandate.updateTx,
    event: "PolicySet",
    summary: "Mandate version 3 set by the owner",
  },
];

export const setupSteps: readonly SetupStep[] = [
  {
    id: "connect-wallet",
    title: "Connect the owner wallet",
    actor: "owner",
    hint: "The wallet that signs the mandate and approvals.",
    done: true,
  },
  {
    id: "set-mandate",
    title: "Set the first mandate",
    actor: "owner",
    hint: "Budget, max order, categories, approval threshold, daily loss limit.",
    done: true,
  },
  {
    id: "add-mcp",
    title: "Add the MCP server to Grok Bot",
    actor: "owner",
    hint: "Paste the address below into Grok Bot's connector settings.",
    done: true,
  },
  {
    id: "claim-agent",
    title: "Claim the agent",
    actor: "owner",
    hint: "Grok Bot asks to connect; confirm the pairing code matches.",
    done: false,
  },
  {
    id: "fund-gateway",
    title: "Fund the agent's payment balance",
    actor: "owner",
    hint: "USDC the agent spends on paid signals over x402.",
    done: false,
  },
];

export const mcpEndpoint = "https://mandate.example/mcp";
export const pairingCode = "7Q4-K2M";

export const changeRequests: readonly ChangeRequest[] = [
  {
    id: "cr-0001",
    at: "2026-11-15T14:03:10.000Z",
    field: "maxOrderCents",
    fromCents: 5_000,
    toCents: 7_500,
    reason: "The macro hedge needs one order of about $62; splitting it costs more in fees.",
  },
];

/** Public scorecard extras. Counts by status are derived from `intents`, never stored twice. */
export const scorecard = {
  /** Held intents the owner later signed, across the agent's life. */
  ownerApprovals: 4,
  /** Hedge payout so far; zero until a ladder market settles. */
  hedgeOutcomeCents: 0,
};
