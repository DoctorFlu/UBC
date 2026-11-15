import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { MandateView } from "@/features/mandate";
import { previewState } from "@/lib/preview";
import { agent, changeRequests, mandate } from "@/mock";

export const metadata: Metadata = { title: "Mandate" };

export default async function MandatePage({ searchParams }: PageProps<"/mandate">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Mandate" />;
  if (preview === "error") return <ViewError title="Mandate" view="The mandate" />;
  return (
    <MandateView agent={agent} mandate={mandate} changeRequests={preview === "empty" ? [] : changeRequests} />
  );
}
