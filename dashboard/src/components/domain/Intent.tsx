import {
  type IntentView,
  type MarketListing,
  intentAnomalies,
  isValidLimitPrice,
  quantityHundredthsFromAmount,
} from "@mandate/shared";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";

import { StatusChip } from "@/components/ui/StatusChip";
import { Advanced } from "@/lib/advanced/Advanced";

import { formatCount, formatUsdCents } from "@/lib/format";
import { categoryName, describeMarket, namingCategory } from "@/lib/markets";

import styles from "./domain.module.css";

/**
 * A market as the owner reads it: "BTC $65,000 or above", then the settle time; Advanced view adds the exact symbol.
 * Text that is not a Gemini symbol (only a stolen agent key can store one) is never shown raw here: it
 * reads "Not a Gemini market" with its length and a short quoted preview; the intent page has the rest.
 */
export function MarketName({
  symbol,
  category,
  showCategory = true,
  listing,
}: {
  symbol: string | null;
  /** Gemini's listing, when checked: its category names an unparsed market before the intent's own. */
  listing?: MarketListing | undefined;
  /** The intent's category: it names a market whose symbol is not parsed ("Sports market"). */
  category?: number | null;
  /** Whether the category also follows the settle time, as in tables without a category column. */
  showCategory?: boolean;
}) {
  if (symbol === null) {
    return (
      <span className={styles.market}>
        <span className={styles.marketTitle}>Market not recorded</span>
        <span className={styles.marketSymbol}>No event carried the details</span>
      </span>
    );
  }
  const market = describeMarket(symbol, namingCategory({ category: category ?? null, listing }));
  // An unparsed market's title already names its category.
  const kind = category == null || !showCategory || !market.parsed ? null : categoryName(category);
  if (!market.isSymbol) {
    const size = `${formatCount(market.length)} ${market.length === 1 ? "character" : "characters"}`;
    return (
      <span className={styles.market} data-suspect="">
        <span className={styles.marketTitle}>{market.title}</span>
        <span className={styles.marketMeta}>{[size, kind].filter(Boolean).join(" · ")}</span>
        {market.preview ? (
          <span className={styles.marketPreview} translate="no">
            {market.length === 0 ? "(empty)" : `“${market.preview}”`}
          </span>
        ) : (
          <span className={styles.marketPreview}>(empty)</span>
        )}
      </span>
    );
  }
  const sub = [market.settles ? `Settles ${market.settles}` : null, kind].filter(Boolean).join(" · ");
  return (
    <span className={styles.market}>
      <span className={styles.marketTitle}>{market.title}</span>
      {sub ? <span className={styles.marketMeta}>{sub}</span> : null}
      <Advanced>
        <span className={styles.marketSymbol} translate="no">
          {symbol}
        </span>
      </Advanced>
    </span>
  );
}

type OrderFields = Pick<IntentView, "isBuy" | "outcome" | "amountCents" | "limitPrice" | "outOfRange">;

/** "40" for whole contracts, "29.30" otherwise, from hundredths. */
function contractsText(hundredths: number): string {
  return hundredths % 100 === 0 ? (hundredths / 100).toString() : (hundredths / 100).toFixed(2);
}

/** " YES", " NO", nothing when unknown, or a description of anything else (never its text). */
function outcomeText(outcome: string | null): string {
  if (outcome === null) return "";
  return outcome === "YES" || outcome === "NO" ? ` ${outcome}` : " (outcome not YES or NO)";
}

function isOutOfRange(intent: OrderFields, field: "amountCents" | "limitPrice"): boolean {
  return intent.outOfRange?.[field] !== undefined;
}

/**
 * "Buy NO, 40 at 31¢": the side, outcome, contracts and the limit. The contracts are the order the executor
 * placed on the venue when there is one (`placedHundredths`, issue #117): it is sized so the cost and
 * Gemini's fee fit the amount, so it can be fewer than the amount buys at the limit, which Advanced view adds.
 * Before an order is placed, and on the simulated venue, it is what the amount buys at the limit.
 */
export function OrderSummary({
  intent,
  placedHundredths = null,
}: {
  intent: OrderFields;
  placedHundredths?: number | null;
}) {
  const amountKnown = intent.amountCents !== null || isOutOfRange(intent, "amountCents");
  const limitKnown = intent.limitPrice !== null || isOutOfRange(intent, "limitPrice");
  if (intent.isBuy === null || !amountKnown || !limitKnown) {
    return <span className={styles.orderUnknown}>Order not recorded</span>;
  }
  const side = intent.isBuy ? "Buy" : "Sell";
  const outcome = outcomeText(intent.outcome);
  if (intent.amountCents === null || intent.limitPrice === null || !isValidLimitPrice(intent.limitPrice)) {
    const limit =
      intent.limitPrice === null ? "a limit too large to show" : `limit ${intent.limitPrice.toString()}`;
    return (
      <span className="num">
        {side}
        {outcome} at {limit}
      </span>
    );
  }
  const nominal = quantityHundredthsFromAmount(intent.amountCents, intent.limitPrice);
  const shown = placedHundredths ?? nominal;
  return (
    <span
      className="num"
      data-testid="order-summary"
      data-placed={placedHundredths === null ? undefined : ""}
    >
      {side}
      {outcome}, {contractsText(shown)} at {intent.limitPrice.toString()}¢
      {shown === nominal ? null : (
        <Advanced>
          <span className={styles.orderNominal}> ({contractsText(nominal)} before the fee)</span>
        </Advanced>
      )}
    </span>
  );
}

/** An amount as text: dollars, "Out of range" for a value too large for offchain code, or "Unknown". */
export function amountLabel(intent: Pick<OrderFields, "amountCents" | "outOfRange">): string {
  if (intent.amountCents !== null) return formatUsdCents(intent.amountCents);
  return intent.outOfRange?.["amountCents"] === undefined ? "Unknown" : "Out of range";
}

/** Amount over order, for tables short on width: "$12.40" over "Buy NO, 40 at 31¢". */
export function OrderAmount({
  intent,
  placedHundredths = null,
}: {
  intent: OrderFields;
  placedHundredths?: number | null;
}) {
  return (
    <span className={styles.orderAmount}>
      <span className="num">{amountLabel(intent)}</span>
      <span className={styles.orderLine}>
        <OrderSummary intent={intent} placedHundredths={placedHundredths} />
      </span>
    </span>
  );
}

/**
 * What about an intent the agent's MCP server could never have sent ("outcome is not YES or NO"), for the
 * badge and the intent page. Each clause describes an onchain value; none quotes it.
 */
export function intentFlags(
  intent: Pick<IntentView, "market" | "outcome" | "category" | "limitPrice" | "outOfRange">,
): string[] {
  return intentAnomalies(intent).map((anomaly) => anomaly.text);
}

/**
 * Marks an intent the MCP server could not have sent: the agent key was used around it. Reads "Flagged",
 * and says why to assistive technology and on hover.
 */
export function FlaggedBadge({ flags }: { flags: readonly string[] }) {
  if (flags.length === 0) return null;
  const why = flags.join("; ");
  return (
    <span className={styles.flagged} title={`Not sent by the MCP server: ${why}`} data-testid="flagged-badge">
      <ShieldAlert aria-hidden className={styles.flaggedIcon} strokeWidth={2} />
      Flagged
      <span className="visually-hidden">: not sent by the MCP server, {why}</span>
    </span>
  );
}

/** The contract's verdict, then "Flagged" beside it when the MCP server could not have sent the intent. */
export function IntentVerdict({ intent }: { intent: IntentView }) {
  return (
    <span className={styles.verdict}>
      <StatusChip status={intent.status} reason={intent.reason} />
      <FlaggedBadge flags={intentFlags(intent)} />
    </span>
  );
}

/** "Intent 3", linking to its detail page with every onchain step. */
export function IntentLink({ id }: { id: number }) {
  return (
    <Link href={`/activity/${id.toString()}`} className={styles.intentLink}>
      <span className="visually-hidden">Intent </span>#{id}
    </Link>
  );
}
