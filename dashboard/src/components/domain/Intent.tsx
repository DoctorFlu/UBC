import { type IntentView, isValidLimitPrice, quantityFromAmount } from "@mandate/shared";

import Link from "next/link";

import { formatUsdCents } from "@/lib/format";
import { categoryName, describeMarket } from "@/lib/markets";

import styles from "./domain.module.css";

/** A market as the owner reads it: "BTC $65,000 or above", then the settle time and the exact symbol. */
export function MarketName({ symbol, category }: { symbol: string | null; category?: number | null }) {
  if (symbol === null) {
    return (
      <span className={styles.market}>
        <span className={styles.marketTitle}>Market not recorded</span>
        <span className={styles.marketSymbol}>No event carried the details</span>
      </span>
    );
  }
  const market = describeMarket(symbol);
  const kind = category == null ? null : categoryName(category);
  const sub = [market.settles ? `Settles ${market.settles}` : null, kind].filter(Boolean).join(" · ");
  return (
    <span className={styles.market}>
      <span className={styles.marketTitle}>{market.title}</span>
      {sub ? <span className={styles.marketMeta}>{sub}</span> : null}
      {market.title === symbol ? null : (
        <span className={styles.marketSymbol} translate="no">
          {symbol}
        </span>
      )}
    </span>
  );
}

type OrderFields = Pick<IntentView, "isBuy" | "outcome" | "amountCents" | "limitPrice">;

/** "40" for whole contracts, "29.30" otherwise. */
function contracts(amountCents: number, limitPrice: number): string {
  const quantity = quantityFromAmount(amountCents, limitPrice);
  return Number.isInteger(quantity) ? quantity.toString() : quantity.toFixed(2);
}

/** "Buy NO, 40 at 31¢": the side, outcome, contracts the amount buys at the limit, and the limit. */
export function OrderSummary({ intent }: { intent: OrderFields }) {
  if (intent.isBuy === null || intent.amountCents === null || intent.limitPrice === null) {
    return <span className={styles.orderUnknown}>Order not recorded</span>;
  }
  const side = intent.isBuy ? "Buy" : "Sell";
  const outcome = intent.outcome ? ` ${intent.outcome}` : "";
  if (!isValidLimitPrice(intent.limitPrice)) {
    return (
      <span className="num">
        {side}
        {outcome} at limit {intent.limitPrice.toString()}
      </span>
    );
  }
  return (
    <span className="num">
      {side}
      {outcome}, {contracts(intent.amountCents, intent.limitPrice)} at {intent.limitPrice.toString()}¢
    </span>
  );
}

/** Amount over order, for tables short on width: "$12.40" over "Buy NO, 40 at 31¢". */
export function OrderAmount({ intent }: { intent: OrderFields }) {
  return (
    <span className={styles.orderAmount}>
      <span className="num">
        {intent.amountCents === null ? "Unknown" : formatUsdCents(intent.amountCents)}
      </span>
      <span className={styles.orderLine}>
        <OrderSummary intent={intent} />
      </span>
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
