import { FlaskConical } from "lucide-react";

import { DEV_SIGNER_ENABLED } from "@/lib/wallet/flags";

import styles from "./Shell.module.css";

/** Always visible while the dev signer is enabled, so nobody mistakes it for a real wallet. */
export function DevSignerBadge({ short = false }: { short?: boolean }) {
  if (!DEV_SIGNER_ENABLED) return null;
  return (
    <span
      className={styles.devBadge}
      title="Signing with a public anvil test key (NEXT_PUBLIC_DEV_SIGNER=1). Never use with real funds."
      data-testid="dev-signer-badge"
    >
      <FlaskConical aria-hidden strokeWidth={2} />
      {short ? "Dev" : "Dev signer"}
      {short ? <span className="visually-hidden"> signer</span> : null}
    </span>
  );
}
