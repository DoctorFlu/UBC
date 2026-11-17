/**
 * `npm run dev:settle-proof [-- hourly|daily]`: proves settlement against Gemini's LIVE public API
 * (issue #93 follow-up). No key and nothing placed: the simulated venue, on a throwaway local anvil.
 *
 * It plans with the real planner on the soonest hourly (default) or daily BTC ladder, proposes the plan's
 * orders, lets the executor fill them and then settle them by itself once Gemini publishes the outcome,
 * and prints when Gemini resolved each strike, measured from Gemini's own `resolvedAt` against the expiry
 * (not from when this script happened to look). It stops 45 minutes after expiry at the latest.
 */
import { createGeminiClient, type MarketEvent } from "@mandate/gemini";
import { planHedge } from "@mandate/planner";
import { Category, formatCents, settlementTotals, type Settlement } from "@mandate/shared";
import { DEMO_POLICY, simulatedVenue, startExecutor, type SettlementSink } from "../src";
import { deployTestPolicy, startTestAnvil } from "../test/harness";

const say = (line: string) => {
  console.log(`${new Date().toISOString()} ${line}`);
};

const horizon = process.argv[2] === "daily" ? "daily" : "hourly";
const gemini = createGeminiClient({ maxRetries: 2, timeoutMs: 10_000 });

const listings = await gemini.listLadders("BTC");
say(`BTC ladders: ${listings.map((l) => `${l.eventTicker} (${l.kind}, expires ${l.expiry})`).join("; ")}`);
const ladder = await gemini.getLadder({ asset: "BTC", horizon, depth: "below-spot" });
say(
  `planning on ${ladder.eventTicker}, expiry ${ladder.expiry}, spot $${String(ladder.spot.midCents / 100)}`,
);

const plan = planHedge({
  holding: { asset: "BTC", quantity: "0.01" },
  ladder,
  goal: { dropPercent: 1 },
  maxCostCents: 1_500,
  limits: { maxTradeCents: 2_000, remainingBudgetCents: 15_000, categoryAllowed: true },
});
const orders = plan.rungs.flatMap((rung) => rung.orders);
say(
  `plan ${plan.status}: ${orders.map((o) => `${o.instrumentSymbol} NO ${o.quantity} at ${String(o.limitPriceCents)}c`).join(", ") || "no orders"}`,
);
if (orders.length === 0) process.exit(1);

const anvil = await startTestAnvil();
const chain = await deployTestPolicy(anvil, "production");
await chain.user.setPolicy(DEMO_POLICY);
const ids: number[] = [];
for (const order of orders) {
  const result = await chain.agent.proposeTrade({
    market: order.instrumentSymbol,
    category: Category.Crypto,
    outcome: "NO",
    isBuy: true,
    amountCents: order.amountCents,
    limitPrice: order.limitPriceCents,
  });
  if (result.verdict === "needs_approval") await chain.user.approveIntent(result.intentId);
  say(`intent #${String(result.intentId)}: ${result.verdict}`);
  ids.push(result.intentId);
}

const stored = new Set<number>();
const documents: Settlement[] = [];
const sink: SettlementSink = {
  record(request) {
    stored.add(request.document.intentId);
    documents.push(request.document);
    say(
      `stored the settlement of intent #${String(request.document.intentId)}: ${JSON.stringify(request.document)}`,
    );
    return Promise.resolve({ status: "stored" });
  },
};
const executor = startExecutor({
  client: chain.executor,
  venue: simulatedVenue(gemini),
  settlements: sink,
  fromBlock: chain.deployBlock,
  fillDelayMs: 0,
  pollingIntervalMs: 500,
  settleIntervalMs: 5_000,
  openRecheckMs: 30_000,
  settleBackoffMs: [15_000],
  log: say,
});

const expiry = Date.parse(ladder.expiry);
const deadline = expiry + 45 * 60_000;
while (!ids.every((id) => stored.has(id)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const event: MarketEvent | null = await gemini.getEvent(ladder.eventTicker).catch(() => null);
const delays = (event?.contracts ?? []).flatMap((contract) =>
  contract.resolvedAt === null ? [] : [(Date.parse(contract.resolvedAt) - expiry) / 1000],
);
say(
  delays.length === 0
    ? "Gemini had not published the outcome"
    : `Gemini resolved ${String(delays.length)} strikes between ${String(Math.min(...delays))} s and ` +
        `${String(Math.max(...delays))} s after expiry (its own resolvedAt); event status ${String(event?.status)}`,
);
executor.stop();
await anvil.stop();
// The same numbers the console and the agent report: cost, the estimated fee when any, payout, net after fees.
const totals = settlementTotals(documents);
say(
  `settled totals: cost ${formatCents(totals.costCents)}, ` +
    (totals.feesEstimated ? `fees ${formatCents(totals.feeCents)} (estimated), ` : "") +
    `paid ${formatCents(totals.payoutCents)}, net ${formatCents(totals.pnlCents)}`,
);
say(`done: ${String(stored.size)} of ${String(ids.length)} positions settled`);
process.exit(stored.size === ids.length ? 0 : 1);
