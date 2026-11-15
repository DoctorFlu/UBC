import Link from "next/link";

import { cx } from "@/lib/cx";

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

export function Brand({ showTag = true, nameClassName }: { showTag?: boolean; nameClassName?: string }) {
  return (
    <Link href="/" className={styles.brand} aria-label="Mandate, overview">
      <BrandMark />
      <span className={cx(styles.brandName, nameClassName)}>Mandate</span>
      {showTag ? <span className={styles.brandTag}>Testnet</span> : null}
    </Link>
  );
}
