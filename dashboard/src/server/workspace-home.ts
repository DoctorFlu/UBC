import "server-only";

import type { MandateSummary, WorkspaceHomeData } from "@/features/workspace/types";
import { needsOwner } from "@/lib/live/attention";

import type { Access } from "./accounts/accounts";
import { getConsoleService } from "./console";
import { coverOfSnapshot } from "./cover-summary";
import { mandateView } from "./http/mandates-api";
import { getMarketQuotes } from "./market/quotes";

/**
 * The workspace Home (#95): for each mandate, what waits for the owner, what is committed, and the cover
 * of its current goals. Each row is read from that mandate's own snapshot, so one mandate's numbers never
 * include another's.
 */
export async function workspaceHome(access: Access): Promise<WorkspaceHomeData> {
  const service = getConsoleService();
  const quotes = getMarketQuotes();
  const mandates = service.accounts.store.mandates(access.workspace.id);
  const rows = await Promise.all(
    mandates.map(async (mandate): Promise<MandateSummary> => {
      const snapshot = service.snapshot(mandate);
      const cover = await coverOfSnapshot(snapshot, (asset, eventTicker) =>
        quotes.ladder(asset, eventTicker),
      );
      return {
        mandate: mandateView(service, mandate),
        waiting: needsOwner(snapshot).total,
        paused: snapshot.chain?.paused ?? null,
        committedCents: snapshot.chain?.committedCents ?? null,
        budgetCents: snapshot.chain?.rules?.budgetCents ?? null,
        cover: {
          goals: cover.length,
          met: cover.filter((goal) => goal.state === "met" || goal.state === "nothing_to_cover").length,
          short: cover.filter((goal) => goal.state === "partly_met" || goal.state === "not_met").length,
          unavailable: cover.filter((goal) => goal.state === "unavailable").length,
        },
      };
    }),
  );
  const limit = service.config.mandates.maxPerWorkspace;
  return {
    workspaceName: access.workspace.name,
    mandates: rows,
    limit,
    canCreate: access.member.role === "admin" && mandates.length < limit,
  };
}
