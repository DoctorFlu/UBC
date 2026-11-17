import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { ApprovalsView } from "@/features/approvals";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const params = await searchParams;
  const preview = previewState(params);
  if (preview === "loading") return <ViewSkeleton title="Approvals" />;
  if (preview === "error") return <ViewError title="Approvals" view="Approvals" />;
  return (
    <ApprovalsView
      tab={params.show === "decided" ? "decided" : "waiting"}
      {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})}
    />
  );
}
