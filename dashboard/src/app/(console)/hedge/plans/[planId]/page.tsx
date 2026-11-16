import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { EvidenceView } from "@/features/evidence";
import { previewState } from "@/lib/preview";
import { getConsoleService } from "@/server/console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evidence chain" };

/** The agent API accepts plan ids of 1 to 128 characters; anything else names no stored plan. */
function storedPlan(planId: string) {
  if (planId.length === 0 || planId.length > 128) return null;
  return getConsoleService().planView(planId);
}

/**
 * One plan's evidence chain. The plan is read once here, by id, so a plan a newer one replaced on the
 * hedge page still has its chain; the chain itself follows the live snapshot in the browser.
 */
export default async function PlanEvidencePage({ params, searchParams }: PageProps<"/hedge/plans/[planId]">) {
  const { planId } = await params;
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Evidence chain" />;
  if (preview === "error") return <ViewError title="Evidence chain" view="The evidence chain" />;
  let id = planId;
  try {
    id = decodeURIComponent(planId);
  } catch {
    // Not percent-encoded: the id as given.
  }
  const view = storedPlan(id) ?? (id === planId ? null : storedPlan(planId));
  if (!view) notFound();
  return <EvidenceView view={view} />;
}
