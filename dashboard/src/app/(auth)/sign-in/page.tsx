import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInView } from "@/features/auth/AuthViews";
import { safeNext } from "@/lib/accounts/next";
import { getConsoleService } from "@/server/console";
import { pageAccess } from "@/server/page-access";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const target = safeNext(typeof next === "string" ? next : null);
  if (await pageAccess()) redirect(target);
  const canClaim = getConsoleService().accounts.store.firstWorkspace().claimedAt === null;
  return <SignInView next={target} canClaim={canClaim} />;
}
