import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import type { AccountView } from "@/lib/accounts/types";

import type { Access } from "./accounts/accounts";
import type { Mandate } from "./accounts/store";
import { getConsoleService } from "./console";
import { sessionCookieName } from "./http/session";

/**
 * Server pages' side of sessions. Every console page and layout that reads a mandate's data goes through
 * `pageScope`, so a page never renders without a live session, and only ever the session's own mandate.
 */

/** The live session behind this request's cookie, or null. */
export async function pageAccess(): Promise<Access | null> {
  const service = getConsoleService();
  const cookie = (await cookies()).get(sessionCookieName(service.config.accounts));
  return service.accounts.access(cookie?.value ?? null);
}

/**
 * The signed-in member and the mandate the console shows, or a redirect to the sign-in page. Phase 1 has
 * one mandate per workspace, so pages show the workspace's first; the API routes already take `?mandate=`.
 */
export async function pageScope(): Promise<{ access: Access; mandate: Mandate }> {
  const access = await pageAccess();
  if (!access) redirect("/sign-in");
  const mandate = getConsoleService().accounts.mandateFor(access, null);
  if (!mandate) redirect("/sign-in");
  return { access, mandate };
}

export function accountView(access: Access): AccountView {
  return {
    member: { name: access.member.name, role: access.member.role },
    workspace: { name: access.workspace.name },
  };
}
