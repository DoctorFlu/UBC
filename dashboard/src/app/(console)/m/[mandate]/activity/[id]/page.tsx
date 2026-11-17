import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { IntentDetailView } from "@/features/activity";
import { emptyFixtureSnapshot } from "@/fixtures";
import { previewState } from "@/lib/preview";

/** Intent ids are array indexes in the contract: 0, 1, 2 and so on. */
function parseIntentId(value: string): number | null {
  if (!/^(0|[1-9]\d{0,15})$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/m/[mandate]/activity/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Intent #${id}` };
}

export default async function IntentPage({ params, searchParams }: PageProps<"/m/[mandate]/activity/[id]">) {
  const { id } = await params;
  const intentId = parseIntentId(id);
  if (intentId === null) notFound();
  const title = `Intent #${intentId.toString()}`;
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title={title} />;
  if (preview === "error") return <ViewError title={title} view="This intent" />;
  return (
    <IntentDetailView
      intentId={intentId}
      {...(preview === "empty" ? { preview: emptyFixtureSnapshot } : {})}
    />
  );
}
