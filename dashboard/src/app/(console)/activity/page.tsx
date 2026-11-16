import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { ActivityView } from "@/features/activity";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Activity" />;
  if (preview === "error") return <ViewError title="Activity" view="Activity" />;
  return <ActivityView {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})} />;
}
