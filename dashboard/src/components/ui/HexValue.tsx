import { ExternalLink } from "lucide-react";

import { explorerAddressUrl, explorerTxUrl } from "@/lib/chain";
import { cx } from "@/lib/cx";
import { shortenHex } from "@/lib/format";

import { CopyButton, iconButtonClass } from "./CopyButton";
import styles from "./HexValue.module.css";

export interface HexValueProps {
  value: string;
  kind: "address" | "tx";
  /** A visible label before the value, e.g. "Owner". */
  label?: string;
  /** Show the full value instead of 0x1234…abcd. */
  full?: boolean;
  copy?: boolean;
  /** Link to the Arc explorer. Hidden on the local chain, which has no explorer. */
  explorer?: boolean;
  className?: string;
}

const kindWord = { address: "address", tx: "transaction" };

/** An address or transaction hash: shortened, copyable, and linked to the explorer. */
export function HexValue({
  value,
  kind,
  label,
  full = false,
  copy = true,
  explorer = true,
  className,
}: HexValueProps) {
  const href = explorer ? (kind === "address" ? explorerAddressUrl(value) : explorerTxUrl(value)) : undefined;
  return (
    <span className={cx(styles.hex, className)}>
      {label ? <span className={styles.label}>{label}</span> : null}
      <span className={styles.value} title={value} translate="no">
        {full ? value : shortenHex(value)}
      </span>
      {copy ? <CopyButton value={value} what={kindWord[kind]} /> : null}
      {href ? (
        <a
          className={iconButtonClass}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${kindWord[kind]} in the Arc explorer`}
        >
          <ExternalLink aria-hidden strokeWidth={1.75} />
        </a>
      ) : null}
    </span>
  );
}
