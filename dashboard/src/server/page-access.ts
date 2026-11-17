import "server-only";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import type { AccountView, MandateView } from "@/lib/accounts/types";
import { mandatePath } from "@/lib/mandate-path";

import type { Access } from "./accounts/accounts";
import type { Mandate } from "./accounts/store";
import { getConsoleService } from "./console";
import { mandateView } from "./http/mandates-api";
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

/** The signed-in member, or a redirect to the sign-in page (which brings them back to `next`). */
export async function workspaceScope(next?: string): Promise<{ access: Access }> {
  const access = await pageAccess();
  if (!access) redirect(next && next !== "/" ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  return { access };
}

/**
 * The signed-in member and the mandate the URL names (`/m/<id>`, #95), or a redirect to the sign-in page.
 * A mandate outside the member's workspace is not found, exactly like one that does not exist, so a page
 * never says whether another workspace's mandate id is real.
 */
export async function pageScope(mandateId: string): Promise<{ access: Access; mandate: Mandate }> {
  const { access } = await workspaceScope(mandatePath(mandateId));
  const mandate = getConsoleService().accounts.mandateFor(access, mandateId);
  if (!mandate || mandateId === "") notFound();
  return { access, mandate };
}

/** Every mandate of the member's workspace, oldest first, as the switcher and Home list them. */
export function workspaceMandates(access: Access): MandateView[] {
  const service = getConsoleService();
  return service.accounts.store.mandates(access.workspace.id).map((mandate) => mandateView(service, mandate));
}

export function accountView(access: Access): AccountView {
  return {
    member: { name: access.member.name, role: access.member.role },
    workspace: { name: access.workspace.name },
  };
}
