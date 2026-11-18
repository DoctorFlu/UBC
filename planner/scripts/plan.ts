/**
 * Fetch a live ladder from Gemini's public API and print a hedge plan, for manual checking.
 * Read-only: it never places an order.
 *
 *   npm run plan -- --asset BTC --qty 0.05 --floor 64000 --max-cost 45
 *
 * Money flags are in dollars. Options:
 *   --asset <BTC|ETH|...>     underlying (required)
 *   --qty <units>             holding size (required)
 *   --floor <usd> | --drop <percent>   how far down to protect (one required)
 *   --ceiling <usd>           where protection starts (default: highest strike at or below spot)
 *   --max-cost <usd>          most to spend on the hedge (required)
 *   --horizon <hourly|daily|weekly|month-end>  default weekly
 *   --expiry <iso>            pick the ladder by exact expiry instead of horizon
 *   --max-trade <usd>         per-order cap (default 100)
 *   --budget <usd>            remaining policy budget (default 1000)
 *   --slippage <cents>        added to each NO price (default 0)
 *   --json                    print the full plan as JSON
 */
import { parseArgs } from "node:util";
import { createGeminiClient, LADDER_KINDS, toCents, type LadderKind } from "@mandate/gemini";
import {
  formatContracts,
  formatEasternTime,
  formatPrice,
  formatUsd,
  planHedge,
  summarizePlan,
  type ProtectionGoal,
} from "../src/index";

const { values } = parseArgs({
  options: {
    asset: { type: "string" },
    qty: { type: "string" },
    floor: { type: "string" },
    drop: { type: "string" },
    ceiling: { type: "string" },
    "max-cost": { type: "string" },
    horizon: { type: "string", default: "weekly" },
    expiry: { type: "string" },
    "max-trade": { type: "string", default: "100" },
    budget: { type: "string", default: "1000" },
    slippage: { type: "string", default: "0" },
    json: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function dollars(flag: string, value: string | undefined): number {
  if (value === undefined) fail(`--${flag} is required`);
  const cents = toCents(value.replace(/[$,]/g, ""), "exact");
  if (cents === null || cents < 0) fail(`--${flag} must be a dollar amount with at most two decimals`);
  return cents;
}

const asset = values.asset ?? fail("--asset is required");
const quantity = values.qty ?? fail("--qty is required");
const horizon = values.horizon as LadderKind;
if (!LADDER_KINDS.includes(horizon)) fail(`--horizon must be one of ${LADDER_KINDS.join(", ")}`);

const ceiling = values.ceiling === undefined ? {} : { ceilingCents: dollars("ceiling", values.ceiling) };
let goal: ProtectionGoal;
if (values.floor !== undefined) goal = { floorCents: dollars("floor", values.floor), ...ceiling };
else if (values.drop !== undefined) goal = { dropPercent: Number(values.drop), ...ceiling };
else fail("--floor or --drop is required");

const slippageCents = Number(values.slippage);
if (!Number.isInteger(slippageCents) || slippageCents < 0) fail("--slippage must be whole cents");

const client = createGeminiClient();
const ladder = await client.getLadder({
  asset,
  ...(values.expiry === undefined ? { horizon } : { expiry: values.expiry }),
  depth: "below-spot",
});

const plan = planHedge({
  holding: { asset, quantity },
  ladder,
  goal,
  maxCostCents: dollars("max-cost", values["max-cost"]),
  limits: {
    maxTradeCents: dollars("max-trade", values["max-trade"]),
    remainingBudgetCents: dollars("budget", values.budget),
    categoryAllowed: true,
  },
  slippageCents,
});

if (values.json) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const pad = (text: string, width: number) => text.padStart(width);
console.log(
  `Ladder   ${ladder.eventTicker} (${ladder.kind}), "${ladder.title}", settles ${formatEasternTime(ladder.expiry)}`,
);
console.log(
  `Spot     ${formatUsd(ladder.spot.midCents)} (Gemini ${ladder.spot.symbol} mid; settles on ${ladder.settlementIndex ?? "n/a"})`,
);
console.log(`Plan     ${plan.planId}  status ${plan.status}`);
console.log(
  `Range    ${plan.ceilingCents === null ? "n/a" : formatPrice(plan.ceilingCents)} down to ${plan.floorCents === null ? "n/a" : formatPrice(plan.floorCents)}`,
);
console.log("");
console.log(
  `${pad("strike", 10)} ${pad("NO qty", 9)} ${pad("limit", 6)} ${pad("cost", 9)} ${pad("depth", 9)}  instrument`,
);
for (const rung of plan.rungs) {
  const depth = ladder.rungs.find((r) => r.instrumentSymbol === rung.instrumentSymbol)?.depth
    ?.noBuyHundredths;
  console.log(
    `${pad(formatPrice(rung.strikeCents), 10)} ${pad(rung.quantity, 9)} ${pad(`${rung.limitPriceCents.toString()}c`, 6)} ${pad(formatUsd(rung.amountCents), 9)} ${pad(depth === undefined ? "-" : formatContracts(depth), 9)}  ${rung.instrumentSymbol}${rung.orders.length > 1 ? ` (${rung.orders.length.toString()} orders)` : ""}`,
  );
}
console.log("");
console.log(
  `Totals   cost ${formatUsd(plan.totals.costCents)}, max payout ${formatUsd(plan.totals.maxPayoutCents)}, ${plan.totals.orderCount.toString()} order${plan.totals.orderCount === 1 ? "" : "s"}`,
);
if (plan.totals.lossAtFloorCents !== null && plan.totals.coverageAtFloorBps !== null) {
  console.log(
    `Floor    loss ${formatUsd(plan.totals.lossAtFloorCents)}, hedge pays ${formatUsd(plan.totals.payoutBelowFloorCents)} below it (${(plan.totals.coverageAtFloorBps / 100).toFixed(2)}% covered)`,
  );
}
for (const note of plan.breakEven.notes) console.log(`Note     ${note}`);
for (const warning of plan.warnings) console.log(`Warning  [${warning.code}] ${warning.message}`);
console.log("");
console.log("Payoff (final price: holding, hedge, net)");
for (const point of plan.payoff) {
  console.log(
    `${pad(formatUsd(point.priceCents), 12)}  ${pad(formatUsd(point.unhedgedPnlCents), 10)} ${pad(formatUsd(point.hedgePnlCents), 10)} ${pad(formatUsd(point.netPnlCents), 10)}`,
  );
}
console.log("");
console.log(summarizePlan(plan));
