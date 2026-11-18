/**
 * Fixtures for `?state=` previews, the component gallery and tests. Live views never read these: they
 * read the console snapshot (lib/live). Everything is typed with @mandate/shared and built the way the
 * server builds it, by reducing a Policy event log, so a fixture can't drift from what the contract emits.
 */
import {
  Category,
  type DecisionContext,
  type PolicyEvent,
  type PolicyRules,
  ZERO_HASH,
  categoryMask,
  hashContext,
  reduceEvents,
} from "@mandate/shared";
import type { Address, Hex } from "viem";

import { buildChainView } from "@/lib/live/chain-view";
import type { ChainView, ConsoleNetwork, ConsoleSnapshot, SealedReason } from "@/lib/live/types";

import { sampleHedgePlan } from "./samples";

/** Anvil account #0, the dev signer's owner address (a public test key; see lib/wallet/dev-signer.ts). */
export const OWNER_ADDRESS: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/** Anvil account #1, standing in for Grok Bot's agent key. */
export const AGENT_ADDRESS: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const EXECUTOR_ADDRESS: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const POLICY_ADDRESS: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const FIXTURE_NETWORK: ConsoleNetwork = {
  kind: "local",
  chainId: 5042002,
  name: "Local dev chain",
  rpcUrl: "http://127.0.0.1:8545",
  explorerUrl: null,
};

export const fixtureRules: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

const BTC_64K = "GEMI-BTC2611202200-HI64000";
const BTC_65K = "GEMI-BTC2611202200-HI65000";
const BTC_66K = "GEMI-BTC2611202200-HI66000";
const ETH_2800 = "GEMI-ETH2611202200-HI2800";
const NBA = "GEMI-NBA2611161900-LAL";

/** 2026-11-15 13:20:00 UTC. */
const START = 1_794_748_800;

/** The receipt id (the x402 authorization nonce) of the signal the fixture's agent paid for. */
export const FIXTURE_RECEIPT = `0x${"7c".repeat(32)}` as const;

export const fixtureContext: DecisionContext = {
  version: 1,
  requestText: "Protect my 0.05 BTC below $66,000 this week.",
  planId: "plan_3f0c9a1b5e2d7c48",
  rungIndex: 0,
  ladderSummary: {
    eventTicker: "BTC2611202200",
    observedAt: "2026-11-15T13:24:30.000Z",
    rungs: [
      { instrumentSymbol: BTC_66K, label: "$66,000 or above", yesBidCents: 68, yesAskCents: 69 },
      { instrumentSymbol: BTC_65K, label: "$65,000 or above", yesBidCents: 77, yesAskCents: 78 },
      { instrumentSymbol: BTC_64K, label: "$64,000 or above", yesBidCents: 75, yesAskCents: 76 },
    ],
  },
  signalReceiptIds: [FIXTURE_RECEIPT],
  reason: "The $66,000 rung pays first if BTC falls this week, and costs the least per dollar covered.",
  createdAt: "2026-11-15T13:24:40.000Z",
};

const VERIFIED_HASH = hashContext(fixtureContext);
const TAMPERED_HASH: Hex = `0x${"5a".repeat(32)}`;
const UNSTORED_HASH: Hex = `0x${"c3".repeat(32)}`;

/** A Policy event without its block, transaction and log index (Omit over each member of the union). */
type EventBody = PolicyEvent extends infer E
  ? E extends PolicyEvent
    ? Omit<E, "blockNumber" | "blockTimestamp" | "transactionHash" | "logIndex">
    : never
  : never;

/** A Policy event log: a mandate, then a morning of hedging with every verdict the contract gives. */
function fixtureEvents(): PolicyEvent[] {
  const events: PolicyEvent[] = [];
  let block = 1_204;
  let time = START;
  let tx = 0;
  const step = (seconds: number) => {
    block += 1 + Math.floor(seconds / 2);
    time += seconds;
    tx += 1;
    return {
      blockNumber: block,
      blockTimestamp: time,
      transactionHash: `0x${tx.toString(16).padStart(4, "0")}${"ab".repeat(30)}` as Hex,
    };
  };
  const push = (meta: ReturnType<typeof step>, ...items: EventBody[]) => {
    items.forEach((item, logIndex) => events.push({ ...meta, logIndex, ...item }));
  };

  push(step(0), { type: "PolicyUpdated", rules: fixtureRules }, { type: "Paused", paused: false });

  const propose = (
    intentId: number,
    market: string,
    category: number,
    amountCents: number,
    limitPrice: number,
    contextHash: Hex = ZERO_HASH,
  ) => ({
    type: "IntentProposed" as const,
    intentId,
    agent: AGENT_ADDRESS,
    market,
    category,
    outcome: "NO",
    isBuy: true,
    amountCents,
    limitPrice,
    contextHash,
  });
  const approved = (intentId: number, market: string, amountCents: number, limitPrice: number) => ({
    type: "IntentApproved" as const,
    intentId,
    market,
    outcome: "NO",
    isBuy: true,
    amountCents,
    limitPrice,
  });

  push(
    step(240),
    propose(0, BTC_66K, Category.Crypto, 1_240, 31, VERIFIED_HASH),
    approved(0, BTC_66K, 1_240, 31),
  );
  push(step(6), { type: "ResultRecorded", intentId: 0, filled: true, filledCents: 1_240, pnlCents: 0 });
  push(
    step(20),
    propose(1, BTC_65K, Category.Crypto, 1_320, 22, TAMPERED_HASH),
    approved(1, BTC_65K, 1_320, 22),
  );
  push(step(5), { type: "ResultRecorded", intentId: 1, filled: true, filledCents: 1_320, pnlCents: 0 });
  push(step(30), propose(2, ETH_2800, Category.Crypto, 450, 9), approved(2, ETH_2800, 450, 9));
  push(step(8), { type: "ResultRecorded", intentId: 2, filled: false, filledCents: 0, pnlCents: 0 });
  push(step(600), propose(3, BTC_64K, Category.Crypto, 2_300, 23), {
    type: "IntentNeedsApproval",
    intentId: 3,
    amountCents: 2_300,
  });
  push(step(90), { type: "IntentRejected", intentId: 3, reason: "rejected by user" });
  push(step(900), propose(4, BTC_64K, Category.Crypto, 3_100, 31), {
    type: "IntentRejected",
    intentId: 4,
    reason: "over max trade size",
  });
  push(step(140), propose(5, NBA, Category.Sports, 1_560, 52), {
    type: "IntentRejected",
    intentId: 5,
    reason: "category not allowed",
  });
  push(step(60), propose(6, BTC_64K, Category.Crypto, 2_400, 24, UNSTORED_HASH), {
    type: "IntentNeedsApproval",
    intentId: 6,
    amountCents: 2_400,
  });
  return events;
}

const sealed: Record<number, SealedReason> = {
  0: {
    status: "verified",
    source: "onchain",
    hash: VERIFIED_HASH,
    document: fixtureContext,
    storedAt: "2026-11-15T13:24:41.000Z",
  },
  1: {
    status: "tampered",
    source: "onchain",
    hash: TAMPERED_HASH,
    storedAt: "2026-11-15T13:25:03.000Z",
    claims: { planId: fixtureContext.planId, signalReceiptIds: [] },
  },
  6: { status: "not_stored", source: "onchain", hash: UNSTORED_HASH },
};

function chainFrom(events: PolicyEvent[], sealedReasons: Record<number, SealedReason>): ChainView {
  const last = events.at(-1);
  const head = {
    blockNumber: (last?.blockNumber ?? 1_204) + 12,
    timestamp: (last?.blockTimestamp ?? START) + 30,
  };
  return buildChainView(reduceEvents(events), head, new Map(), sealedReasons);
}

/** A console mid-session: a mandate, filled and failed intents, rejections and two waiting for the owner. */
export const fixtureSnapshot: ConsoleSnapshot = {
  seq: 1,
  network: FIXTURE_NETWORK,
  feed: {
    source: "rpc",
    health: "live",
    detail: "Following the Policy contract over RPC.",
    lastEventAt: "2026-11-15T14:15:44.000Z",
    lastSyncAt: "2026-11-15T14:16:14.000Z",
    syncedBlock: 2_301,
  },
  contract: {
    address: POLICY_ADDRESS,
    deployBlock: 1_203,
    kind: "reference",
    roles: { user: OWNER_ADDRESS, agent: AGENT_ADDRESS, executor: EXECUTOR_ADDRESS },
    recordsContextHash: true,
    ownerSigner: "wallet",
    consoleOwnerKey: null,
  },
  chain: chainFrom(fixtureEvents(), sealed),
  offchain: {
    holdings: [{ asset: "BTC", quantity: "0.05", note: "Cold wallet" }],
    holdingsUpdatedAt: "2026-11-15T13:21:00.000Z",
    pairing: {
      agentAddress: AGENT_ADDRESS,
      agentName: "Grok Bot",
      serverVersion: "0.1.0",
      status: "confirmed",
      announcedAt: "2026-11-15T13:19:12.000Z",
      confirmedAt: "2026-11-15T13:19:40.000Z",
      isContractAgent: true,
    },
    changeRequests: [
      {
        id: "pcr_0c1d7f3e-5b9a-4c2e-8d61-2f4a9b7e1c55",
        agentAddress: AGENT_ADDRESS,
        proposed: { maxTradeCents: 3_500 },
        reason: "The $64,000 rung costs $31; splitting it into two orders costs more in fees than it saves.",
        status: "pending",
        createdAt: "2026-11-15T14:11:02.000Z",
        resolvedAt: null,
        appliedTxHash: null,
      },
    ],
    plans: [
      {
        planId: sampleHedgePlan.planId,
        asset: "BTC",
        requestText: "Protect my 0.05 BTC down to $62,000 this week, for at most $60.",
        createdAt: "2026-11-15T13:24:31.000Z",
        storedAt: "2026-11-15T13:24:32.000Z",
        plan: sampleHedgePlan,
      },
    ],
    signalPayments: [
      {
        receiptId: FIXTURE_RECEIPT,
        amount: "1000",
        paidAt: "2026-11-15T13:24:21.000Z",
        resource: "/v1/signal/hedge?asset=BTC&horizon=weekly",
        network: "eip155:5042002",
        payer: AGENT_ADDRESS,
        payee: EXECUTOR_ADDRESS,
        settlementId: "9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f",
        signal: {
          signalId: `0x${"4e".repeat(32)}`,
          asset: "BTC",
          eventTicker: "BTC2611202200",
          horizon: "weekly",
          expiry: "2026-11-20T22:00:00.000Z",
          asOf: "2026-11-15T13:24:00.000Z",
          counts: { cheap: 3, fair: 15, expensive: 3, noOffer: 0 },
        },
        recordedAt: "2026-11-15T13:24:22.000Z",
      },
    ],
    signalBudget: {
      buyerAddress: AGENT_ADDRESS,
      day: "2026-11-15",
      dailyBudget: "20000",
      spentToday: "1000",
      maxPricePerPurchase: "5000",
      resetsAt: "2026-11-16T00:00:00.000Z",
      gatewayBalance: "4999000",
      asOf: "2026-11-15T13:24:22.000Z",
      storedAt: "2026-11-15T13:24:23.000Z",
    },
  },
  mcpPublicUrl: "https://mandate-mcp.example.dev/mcp",
  wake: {
    enabled: true,
    dailyCap: 12,
    usedToday: 2,
    leftToday: 10,
    offReason: null,
    priceCheckEveryMs: 300_000,
    lastPriceCheckAt: "2026-11-15T13:25:00.000Z",
    priceProblem: null,
    recent: [
      {
        id: "wk_5b1e0f3a9c2d4e6f7a8b9c0d",
        kind: "owner_decision",
        summary: "The owner rejected #6.",
        count: 1,
        status: "sent",
        result: "HTTP 200",
        occurredAt: "2026-11-15T13:22:10.000Z",
        attemptedAt: "2026-11-15T13:22:11.000Z",
        dueAt: null,
      },
      {
        id: "wk_0c7d2a9e4b1f3a5c6d8e0f12",
        kind: "mandate_changed",
        summary: "The owner changed the rules.",
        count: 1,
        status: "sent",
        result: "HTTP 200",
        occurredAt: "2026-11-15T09:02:40.000Z",
        attemptedAt: "2026-11-15T09:02:41.000Z",
        dueAt: null,
      },
    ],
  },
};

/** The same console with a mandate set and nothing else yet: no intents, holdings, pairing or requests. */
export const emptyFixtureSnapshot: ConsoleSnapshot = {
  ...fixtureSnapshot,
  feed: { ...fixtureSnapshot.feed, lastEventAt: "2026-11-15T13:20:00.000Z" },
  chain: chainFrom(fixtureEvents().slice(0, 2), {}),
  offchain: {
    holdings: [],
    holdingsUpdatedAt: null,
    pairing: null,
    changeRequests: [],
    plans: [],
    signalPayments: [],
    signalBudget: null,
  },
};
