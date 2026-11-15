import type { Metadata } from "next";

import { ViewError, ViewSkeleton } from "@/components/states/ViewStates";
import { SetupView } from "@/features/setup";
import { previewState } from "@/lib/preview";
import { POLICY_ADDRESS, agent, mcpEndpoint, pairingCode, setupSteps } from "@/mock";

export const metadata: Metadata = { title: "Setup" };

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const preview = previewState(await searchParams);
  if (preview === "loading") return <ViewSkeleton title="Setup" />;
  if (preview === "error") return <ViewError title="Setup" view="Setup" />;
  const steps = preview === "empty" ? setupSteps.map((step) => ({ ...step, done: false })) : setupSteps;
  return (
    <SetupView
      agent={agent}
      steps={steps}
      mcpEndpoint={mcpEndpoint}
      pairingCode={pairingCode}
      policyAddress={POLICY_ADDRESS}
    />
  );
}
