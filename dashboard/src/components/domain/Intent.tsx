import type { Intent, Market } from "@/lib/domain";
import { formatContractPrice, formatCount, formatUsdCents } from "@/lib/format";

import styles from "./domain.module.css";

/** A market as the owner reads it: the question first, the symbol under it. */
export function MarketName({ market }: { market: Market }) {
  return (
    <span className={styles.market}>
      <span className={styles.marketTitle}>{market.title}</span>
      <span className={styles.marketSymbol} translate="no">
        {market.symbol}
      </span>
    </span>
  );
}

/** "Buy 120 at 24¢". */
export function OrderSummary({ intent }: { intent: Pick<Intent, "side" | "contracts" | "limitPriceCents"> }) {
  return (
    <span className="num">
      {intent.side === "buy" ? "Buy" : "Sell"} {formatCount(intent.contracts)} at{" "}
      {formatContractPrice(intent.limitPriceCents)}
    </span>
  );
}

/** Amount over order, for tables short on width: "$28.80" over "Buy 120 at 24¢". */
export function OrderAmount({
  intent,
}: {
  intent: Pick<Intent, "side" | "contracts" | "limitPriceCents" | "notionalCents">;
}) {
  return (
    <span className={styles.orderAmount}>
      <span className="num">{formatUsdCents(intent.notionalCents)}</span>
      <span className={styles.orderLine}>
        <OrderSummary intent={intent} />
      </span>
    </span>
  );
}
