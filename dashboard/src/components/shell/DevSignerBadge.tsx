import { FlaskConical } from "lucide-react";

import { type MandateScope, useMandateScope } from "@/lib/mandate/MandateContext";
import { DEV_SIGNER_ENABLED } from "@/lib/wallet/flags";

import styles from "./Shell.module.css";

/**
 * Whether the dev signer can sign for this page's mandate: one whose owner is a wallet (the first
 * workspace's env mandate, or one an owner's wallet deployed), or one a wallet is about to deploy. Never a
 * mandate whose owner key the console holds (its owner actions take a passkey), nor outside a mandate.
 */
export function devSignerSigns(scope: MandateScope | null): boolean {
  if (!scope) return false;
  const { ownerSigner } = scope.mandate;
  return ownerSigner === "wallet" || (ownerSigner === null && scope.deployer === "wallet");
}

/** Always visible where the dev signer can sign, so nobody mistakes it for a real wallet. */
export function DevSignerBadge({ short = false }: { short?: boolean }) {
  const scope = useMandateScope();
  if (!DEV_SIGNER_ENABLED || !devSignerSigns(scope)) return null;
  return (
    <span
      className={styles.devBadge}
      title="Signing with a public anvil test key (NEXT_PUBLIC_DEV_SIGNER=1). Never use with real funds."
      data-testid="dev-signer-badge"
      data-dev-signer=""
    >
      <FlaskConical aria-hidden strokeWidth={2} />
      {short ? "Dev" : "Dev signer"}
      {short ? <span className="visually-hidden"> signer</span> : null}
    </span>
  );
}
