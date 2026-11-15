import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { AuditView } from "@/features/audit";
import { previewState } from "@/lib/preview";
import { POLICY_ADDRESS, auditTrail } from "@/mock";

export const metadata: Metadata = { title: "Audit" };

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Audit" />;
  if (preview === "error") return <ViewError title="Audit" view="The audit trail" />;
  return <AuditView records={preview === "empty" ? [] : auditTrail} policyAddress={POLICY_ADDRESS} />;
}
