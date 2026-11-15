import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { PaymentsView } from "@/features/payments";
import { previewState } from "@/lib/preview";
import { payments, paymentsSummary } from "@/mock";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Payments" />;
  if (preview === "error") return <ViewError title="Payments" view="Payments" />;
  return <PaymentsView payments={preview === "empty" ? [] : payments} summary={paymentsSummary} />;
}
