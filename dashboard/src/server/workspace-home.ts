import "server-only";

import type { MandateSummary, WorkspaceHomeData } from "@/features/workspace/types";
import { needsOwner } from "@/lib/live/attention";

import type { Access } from "./accounts/accounts";
import { getConsoleService } from "./console";
import type { ConsoleService } from "./console-service";
import { coverOfSnapshot } from "./cover-summary";
import { mandateView } from "./http/mandates-api";
import { getMarketQuotes } from "./market/quotes";
import type { LadderSource } from "./wake";

/** How long Home waits for a market's quotes before showing that goal's cover as unknown. */
export const HOME_QUOTES_WAIT_MS = 1_500;

/**
 * The ladder, but answering "not available" after `waitMs`. The lookup itself goes on, and the quotes
 * cache keeps its answer, so a slow market costs Home one unknown cover, never a slow page.
 */
function bounded(ladder: LadderSource, waitMs: number): LadderSource {
  return (asset, eventTicker) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ ok: false }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false });
      }, waitMs);
    });
    const lookup = ladder(asset, eventTicker).catch(() => ({ ok: false as const }));
    return Promise.race([lookup, late]).finally(() => {
      clearTimeout(timer);
    });
  };
}

/**
 * The workspace Home (#95): for each mandate, what waits for the owner, what is committed, and the cover
 * of its current goals. Each row is read from that mandate's own snapshot, so one mandate's numbers never
 * include another's.
 */
export async function workspaceHome(
  access: Access,
  service: ConsoleService = getConsoleService(),
  ladder: LadderSource = (asset, eventTicker) => getMarketQuotes().ladder(asset, eventTicker),
  waitMs = HOME_QUOTES_WAIT_MS,
): Promise<WorkspaceHomeData> {
  const mandates = service.accounts.store.mandates(access.workspace.id);
  const quotes = bounded(ladder, waitMs);
  const rows = await Promise.all(
    mandates.map(async (mandate): Promise<MandateSummary> => {
      const snapshot = service.snapshot(mandate);
      const cover = await coverOfSnapshot(snapshot, quotes);
      return {
        mandate: mandateView(service, mandate),
        owner: snapshot.contract?.roles?.user ?? null,
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
