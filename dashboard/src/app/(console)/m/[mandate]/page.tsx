import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { HomeView } from "@/features/home";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Overview" };

export default async function HomePage({ searchParams }: PageProps<"/m/[mandate]">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Home" />;
  if (preview === "error") return <ViewError title="Home" view="Home" />;
  return <HomeView {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})} />;
}
