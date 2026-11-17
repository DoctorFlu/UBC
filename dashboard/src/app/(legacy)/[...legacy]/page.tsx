import { notFound, redirect } from "next/navigation";
import { isAddress, isAddressEqual } from "viem";

import { MANDATE_VIEWS, mandatePath } from "@/lib/mandate-path";
import { getConsoleService } from "@/server/console";
import { workspaceScope } from "@/server/page-access";

export const dynamic = "force-dynamic";

function queryOf(searchParams: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value])
      query.append(key, one);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * A view's URL from before #95 (`/approvals`, `/activity/3`, ...): the same view of the workspace's first
 * mandate, so bookmarks and the links agents already sent keep working. The pairing link the MCP server
 * gives (`/setup/pair/<address>`) opens the mandate that agent announced itself to. Anything else is not
 * found, before any session check, so this route reveals nothing.
 */
export default async function LegacyViewPage({ params, searchParams }: PageProps<"/[...legacy]">) {
  const { legacy } = await params;
  const view = legacy[0] ?? "";
  if (!(MANDATE_VIEWS as readonly string[]).includes(view)) notFound();
  const path = `/${legacy.map((segment) => encodeURIComponent(segment)).join("/")}`;
  const query = queryOf(await searchParams);
  const { access } = await workspaceScope(`${path}${query}`);
  const service = getConsoleService();
  const mandates = service.accounts.store.mandates(access.workspace.id);
  let target = mandates[0];
  const address = view === "setup" && legacy[1] === "pair" ? legacy[2] : undefined;
  if (address !== undefined && isAddress(address, { strict: false })) {
    target =
      mandates.find((mandate) => {
        const agent = service.accounts.store.agentOf(mandate.id).address;
        return agent !== null && isAddressEqual(agent, address);
      }) ??
      mandates.find((mandate) => service.pairingView(mandate, address) !== null) ??
      target;
  }
  if (!target) notFound();
  redirect(`${mandatePath(target.id, path)}${query}`);
}
