"use client";

import Link from "next/link";

import { cx } from "@/lib/cx";
import { useNetwork } from "@/lib/live/LiveConsole";
import { NETWORK_TAGS } from "@/lib/network";

import styles from "./Shell.module.css";

/** The mark: a breaker plate with its handle up (closed, live). Drawn, not a glyph. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={cx(styles.brandMark, className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.75" y="2.75" width="16.5" height="18.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="5.5" width="6" height="8" rx="1" fill="currentColor" />
      <path d="M8 17.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The logo, with a tag naming the chain the console resolved (Local, Arc testnet). */
export function Brand({ showTag = true, nameClassName }: { showTag?: boolean; nameClassName?: string }) {
  const network = useNetwork();
  return (
    <Link href="/" className={styles.brand}>
      <BrandMark />
      <span className={cx(styles.brandName, nameClassName)}>Mandate</span>
      {showTag && network ? (
        <span className={styles.brandTag} title={network.name} data-testid="network-tag">
          {NETWORK_TAGS[network.kind]}
        </span>
      ) : null}
    </Link>
  );
}
