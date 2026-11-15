/**
 * `npm run dev:propose -- [options]`: submits one trade intent as the agent, for manual testing.
 *
 *   --market   Gemini instrumentSymbol      (default GEMI-BTC2611202200-HI65000)
 *   --category Crypto, Sports, ... or an id  (default Crypto)
 *   --outcome  YES or NO                     (default YES)
 *   --sell     propose a sell instead of a buy
 *   --amount   dollars, for example 10 or 22.50 (default 10)
 *   --price    limit price in cents, 1 to 99 (default 65)
 *   --preview  only report what the contract would decide, without sending a transaction (uses the
 *              contract's previewTrade when it has one, otherwise the offchain evaluator)
 *
 * Uses the devchain agent account, or AGENT_PRIVATE_KEY when POLICY_ADDRESS points at Arc testnet.
 */
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import {
  CATEGORY_IDS,
  categoryLabel,
  describeReason,
  dollarsToCents,
  chainExplorerTxUrl,
  formatCents,
  isCategoryId,
  outcomeSchema,
  quantityFromAmount,
  revertErrorName,
  VERDICT_LABELS,
  type CategoryId,
  type ChainVerdict,
  type Outcome,
} from "@mandate/shared";
import { createPolicyClient, resolvePolicyDeployment } from "@mandate/shared/node";
import { devAccount } from "../src";

const { values } = parseArgs({
  options: {
    market: { type: "string", default: "GEMI-BTC2611202200-HI65000" },
    category: { type: "string", default: "Crypto" },
    outcome: { type: "string", default: "YES" },
    sell: { type: "boolean", default: false },
    amount: { type: "string", default: "10" },
    price: { type: "string", default: "65" },
    preview: { type: "boolean", default: false },
  },
});

function parseCategory(text: string): CategoryId {
  const asNumber = Number(text);
  if (Number.isInteger(asNumber) && isCategoryId(asNumber)) return asNumber;
  const match = CATEGORY_IDS.find((id) => categoryLabel(id).toLowerCase() === text.trim().toLowerCase());
  if (match === undefined) throw new Error(`unknown category "${text}"`);
  return match;
}

function parseOutcome(text: string): Outcome {
  const parsed = outcomeSchema.safeParse(text.trim().toUpperCase());
  if (!parsed.success) throw new Error(`--outcome must be YES or NO, got "${text}"`);
  return parsed.data;
}

function describe(verdict: ChainVerdict): string {
  const label = VERDICT_LABELS[verdict.verdict];
  if (verdict.verdict !== "rejected") return label;
  const { label: reasonLabel, explanation } = describeReason(verdict.reason);
  return `${label}: ${reasonLabel} (${verdict.reason}). ${explanation}`;
}

async function main(): Promise<void> {
  const deployment = resolvePolicyDeployment();
  let account;
  if (deployment.source === "devchain") {
    account = devAccount("agent");
  } else {
    const key = process.env.AGENT_PRIVATE_KEY?.trim();
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(
        "POLICY_ADDRESS is set, so AGENT_PRIVATE_KEY must hold the agent's 0x-prefixed private key",
      );
    }
    account = privateKeyToAccount(key as `0x${string}`);
  }
  const client = createPolicyClient({ account, deployment });

  const intent = {
    market: values.market,
    category: parseCategory(values.category),
    outcome: parseOutcome(values.outcome),
    isBuy: !values.sell,
    amountCents: dollarsToCents(values.amount),
    limitPrice: Number(values.price),
  };

  console.log(
    `${values.preview ? "Previewing" : "Proposing"} ${intent.isBuy ? "BUY" : "SELL"} ${intent.outcome} ` +
      `${intent.market} (${categoryLabel(intent.category)}) for ${formatCents(intent.amountCents)} at ` +
      `${intent.limitPrice}c, about ${quantityFromAmount(intent.amountCents, intent.limitPrice)} contracts`,
  );

  if (values.preview) {
    const preview = await client.previewTrade(intent);
    const source =
      preview.source === "contract"
        ? "from the contract's previewTrade"
        : "simulated offchain: this contract has no previewTrade";
    console.log(`${describe(preview)} [${source}]`);
  } else {
    const result = await client.proposeTrade(intent);
    console.log(`Intent #${result.intentId}: ${describe(result)}`);
    if (!result.contextHashRecorded) {
      console.log("This contract has no contextHash overload, so no decision context hash was recorded.");
    }
    console.log(`Transaction ${result.txHash} in block ${result.blockNumber}`);
    const link = chainExplorerTxUrl(deployment.chain, result.txHash);
    if (link) console.log(link);
  }
}

main().catch((error: unknown) => {
  const name = revertErrorName(error);
  console.error(
    `Error: ${name ? `contract reverted with ${name}` : error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
