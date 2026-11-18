"use client";

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";
import { useNetwork } from "@/lib/live/LiveConsole";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/network";

import styles from "./ExplorerLink.module.css";

/**
 * A plain link to a transaction or an address on the network's explorer, for the default view, where
 * hashes are not shown (Advanced view shows them with HexValue). Nothing on a chain without an explorer,
 * such as the local devchain.
 */
export function ExplorerLink({
  kind,
  value,
  children,
  className,
}: {
  kind: "tx" | "address";
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const network = useNetwork();
  if (!network) return null;
  const href = kind === "tx" ? explorerTxUrl(network, value) : explorerAddressUrl(network, value);
  if (!href) return null;
  return (
    <a
      className={cx(styles.link, className)}
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="explorer-link"
      data-kind={kind}
    >
      {children}
      <ExternalLink aria-hidden strokeWidth={1.75} />
      <span className="visually-hidden"> (opens the explorer in a new tab)</span>
    </a>
  );
}
