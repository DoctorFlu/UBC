import type { Metadata } from "next";

import { NewMandateView } from "@/features/workspace/NewMandateView";
import { getConsoleService } from "@/server/console";
import { workspaceScope } from "@/server/page-access";

export const metadata: Metadata = { title: "New mandate" };

/** A new mandate (#95). The cap and the admin role are enforced by the server; this only says so first. */
export default async function NewMandatePage() {
  const { access } = await workspaceScope("/mandates/new");
  const service = getConsoleService();
  const count = service.accounts.store.mandates(access.workspace.id).length;
  const limit = service.config.mandates.maxPerWorkspace;
  const deployer = service.mandates.deployer();
  const blocked =
    access.member.role !== "admin"
      ? "Only a workspace admin can create a mandate."
      : count >= limit
        ? `This workspace has ${String(count)} of ${String(limit)} mandates, its limit (CONSOLE_MANDATES_PER_WORKSPACE). Ask the operator to raise it.`
        : deployer === null
          ? "The console can't read the chain right now, so it can't deploy a contract. Try again shortly."
          : null;
  return <NewMandateView deployer={deployer ?? "server"} blocked={blocked} />;
}
