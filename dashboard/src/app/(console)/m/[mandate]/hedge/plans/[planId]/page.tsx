import type { Metadata } from "next";
import { SearchX } from "lucide-react";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { EvidenceView } from "@/features/evidence";
import { previewState } from "@/lib/preview";
import type { MandateScope } from "@/server/console-service";
import { getConsoleService } from "@/server/console";
import { pageScope } from "@/server/page-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evidence chain" };

/** The agent API accepts plan ids of 1 to 128 characters; anything else names no stored plan. */
function storedPlan(mandate: MandateScope, planId: string) {
  if (planId.length === 0 || planId.length > 128) return null;
  return getConsoleService().planView(mandate, planId);
}

/**
 * One plan's evidence chain. The plan is read once here, by id, so a plan a newer one replaced on the
 * hedge page still has its chain; the chain itself follows the live snapshot in the browser.
 */
export default async function PlanEvidencePage({
  params,
  searchParams,
}: PageProps<"/m/[mandate]/hedge/plans/[planId]">) {
  const { mandate } = await pageScope((await params).mandate);
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
  const view = storedPlan(mandate, id) ?? (id === planId ? null : storedPlan(mandate, planId));
  if (!view) {
    return (
      <div>
        <PageHeader title="Evidence chain" />
        <EmptyState
          icon={<SearchX strokeWidth={1.75} />}
          title="No plan with this id"
          action={<ArrowLink href="/hedge">Hedge</ArrowLink>}
        >
          The console stores every plan the agent posts, and none has this id. An intent&apos;s reason can
          name a plan the agent never posted; its chain cannot be checked here.
        </EmptyState>
      </div>
    );
  }
  return <EvidenceView view={view} />;
}
