import { CircleSlash, FileSignature, PlugZap } from "lucide-react";
import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState } from "@/components/ui/States";
import type { ConsoleSnapshot } from "@/lib/live/types";

import { ViewSkeleton } from "./ViewStates";

/**
 * What a view shows before the console has chain data: still reading history, no contract configured,
 * or the chain unreachable. Every live view renders this when `snapshot.chain` is null.
 */
export function ChainUnavailable({ snapshot, title }: { snapshot: ConsoleSnapshot; title: string }) {
  const { feed } = snapshot;
  if (feed.health === "starting" || feed.health === "live" || feed.health === "lagging") {
    return <ViewSkeleton title={title} />;
  }
  if (feed.health === "unconfigured") {
    return (
      <div>
        <PageHeader title={title} />
        <EmptyState icon={<PlugZap strokeWidth={1.75} />} title="No Policy contract yet">
          <p>{feed.detail}</p>
          <p>
            Locally, run <code>npm run dev:chain</code>. On Arc testnet, set <code>POLICY_ADDRESS</code> as
            docs/configuration.md describes.
          </p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div>
      <PageHeader title={title} />
      <ErrorState title={`Can't reach ${snapshot.network.name}`}>
        <p>{feed.detail}</p>
        <p>The console keeps retrying on its own and shows the contract as soon as the chain answers.</p>
      </ErrorState>
    </div>
  );
}

/** For views that need rules in force: the owner has not signed a first `setPolicy` yet. */
export function NoPolicyYet({ children }: { children?: ReactNode }) {
  return (
    <EmptyState
      icon={<FileSignature strokeWidth={1.75} />}
      title="No rules yet"
      action={
        <ButtonLink view href="/rules" variant="primary">
          Set the rules
        </ButtonLink>
      }
    >
      {children ??
        "The Policy contract rejects every intent until you confirm its first set of rules. Set a budget, a max trade size and the markets the agent may trade."}
    </EmptyState>
  );
}

export function NothingHere({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EmptyState plain icon={<CircleSlash strokeWidth={1.75} />} title={title}>
      {children}
    </EmptyState>
  );
}
