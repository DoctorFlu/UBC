import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { SetupView } from "@/features/setup";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

export const metadata: Metadata = { title: "Setup" };

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Setup" />;
  if (preview === "error") return <ViewError title="Setup" view="Setup" />;
  return <SetupView {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})} />;
}
