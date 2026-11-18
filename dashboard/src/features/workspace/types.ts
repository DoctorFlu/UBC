import type { Address } from "viem";

import type { MandateView } from "@/lib/accounts/types";

/** One mandate on the workspace Home (#95), from that mandate's own snapshot only. */
export interface MandateSummary {
  mandate: MandateView;
  /** The account the contract names as its owner (`user()`); null without a contract or a read of it. */
  owner: Address | null;
  /** Intents, change requests and a pairing waiting for the owner. */
  waiting: number;
  /** Null while the console cannot read the contract. */
  paused: boolean | null;
  /** Committed on the contract so far, and the budget it counts against; null without the chain or rules. */
  committedCents: number | null;
  budgetCents: number | null;
  /**
   * The current goals' cover: how many are covered, how many are not (partly or not covered, nothing to
   * protect now, or nothing can be bought), and how many cannot be measured now (`coverCounts`).
   */
  cover: { goals: number; met: number; short: number; unavailable: number };
}

export interface WorkspaceHomeData {
  workspaceName: string;
  mandates: MandateSummary[];
  limit: number;
  canCreate: boolean;
}
