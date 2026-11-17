import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { RulesView } from "@/features/rules";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage({ searchParams }: PageProps<"/rules">) {
  const params = await searchParams;
  const preview = previewState(params);
  if (preview === "loading") return <ViewSkeleton title="Rules" />;
  if (preview === "error") return <ViewError title="Rules" view="Rules" />;
  return (
    <RulesView
      tab={params.tab === "requests" ? "requests" : params.tab === "rules" ? "rules" : undefined}
      {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})}
    />
  );
}
