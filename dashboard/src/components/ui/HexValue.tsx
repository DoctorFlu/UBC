"use client";

import { ExternalLink } from "lucide-react";

import { cx } from "@/lib/cx";
import { shortenHex } from "@/lib/format";
import { useNetwork } from "@/lib/live/LiveConsole";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/network";

import { CopyButton, iconButtonClass } from "./CopyButton";
import styles from "./HexValue.module.css";

export interface HexValueProps {
  value: string;
  /** "hash" is any other 32-byte value, such as a decision context hash: never linked to the explorer. */
  kind: "address" | "tx" | "hash";
  /** A visible label before the value, e.g. "Owner". */
  label?: string;
  /** Show the full value instead of 0x1234…abcd. */
  full?: boolean;
  copy?: boolean;
  /** Link to the network's explorer. Hidden on the local chain, which has no explorer. */
  explorer?: boolean;
  className?: string;
}

const kindWord = { address: "address", tx: "transaction", hash: "hash" };

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
  const network = useNetwork();
  const href =
    explorer && network && kind !== "hash"
      ? kind === "address"
        ? explorerAddressUrl(network, value)
        : explorerTxUrl(network, value)
      : undefined;
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
          aria-label={`Open ${kindWord[kind]} in the explorer`}
        >
          <ExternalLink aria-hidden strokeWidth={1.75} />
        </a>
      ) : null}
    </span>
  );
}
