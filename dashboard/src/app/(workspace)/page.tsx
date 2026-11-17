import type { Metadata } from "next";

import { WorkspaceHome } from "@/features/workspace/WorkspaceHome";
import { workspaceScope } from "@/server/page-access";
import { workspaceHome } from "@/server/workspace-home";

export const metadata: Metadata = { title: "Home" };

/** The workspace Home (#95): every mandate, what waits, what is committed and covered. */
export default async function WorkspaceHomePage() {
  const { access } = await workspaceScope();
  return <WorkspaceHome data={await workspaceHome(access)} />;
}
