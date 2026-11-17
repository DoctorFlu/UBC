import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ClaimView } from "@/features/auth/AuthViews";
import { pageAccess } from "@/server/page-access";

export const metadata: Metadata = { title: "Claim this console" };

export default async function ClaimPage() {
  if (await pageAccess()) redirect("/");
  return <ClaimView />;
}
