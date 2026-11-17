import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignUpView } from "@/features/auth/AuthViews";
import { getConsoleService } from "@/server/console";
import { pageAccess } from "@/server/page-access";

export const metadata: Metadata = { title: "Create a workspace" };

export default async function SignUpPage() {
  if (await pageAccess()) redirect("/");
  return <SignUpView inviteRequired={getConsoleService().config.accounts.signup === "invite"} />;
}
