import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ClaimView } from "@/features/auth/AuthViews";
import { getConsoleService } from "@/server/console";
import { pageAccess } from "@/server/page-access";

export const metadata: Metadata = { title: "Claim this console" };

export default async function ClaimPage() {
  if (await pageAccess()) redirect("/");
  // Once claimed, a claim code can never work again: send people to the one action that can.
  if (getConsoleService().accounts.store.firstWorkspace().claimedAt !== null) redirect("/sign-in");
  return <ClaimView />;
}
