import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { HedgeView } from "@/features/hedge";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Hedge" };

export default async function HedgePage({ searchParams }: PageProps<"/m/[mandate]/hedge">) {
  const params = await searchParams;
  const preview = previewState(params);
  const asset = typeof params.asset === "string" ? params.asset.slice(0, 16).toUpperCase() : undefined;
  if (preview === "loading") return <ViewSkeleton title="Hedge" />;
  if (preview === "error") return <ViewError title="Hedge" view="The hedge" />;
  return (
    <HedgeView initialAsset={asset} {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})} />
  );
}
