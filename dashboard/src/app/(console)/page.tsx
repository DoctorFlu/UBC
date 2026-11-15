import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { OverviewView } from "@/features/overview";
import { previewState } from "@/lib/preview";
import { agent, intents, mandate, usage } from "@/mock";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Overview" />;
  if (preview === "error") return <ViewError title="Overview" view="The overview" />;
  return (
    <OverviewView
      agent={agent}
      mandate={mandate}
      usage={usage}
      intents={preview === "empty" ? [] : intents}
    />
  );
}
