import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { HedgeView } from "@/features/hedge";
import { previewState } from "@/lib/preview";
import { hedgePlan, holdings, ladder } from "@/mock";

export const metadata: Metadata = { title: "Hedge" };

export default async function HedgePage({ searchParams }: PageProps<"/hedge">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Hedge" />;
  if (preview === "error") return <ViewError title="Hedge" view="The hedge" />;
  const empty = preview === "empty";
  return <HedgeView holdings={empty ? [] : holdings} ladder={empty ? [] : ladder} plan={hedgePlan} />;
}
