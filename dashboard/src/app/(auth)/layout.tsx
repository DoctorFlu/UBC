import type { ReactNode } from "react";

import { AuthFrame } from "@/features/auth/AuthFrame";

// Every page here reads the session or the sign-up setting on each request.
export const dynamic = "force-dynamic";

/** Sign-in, sign-up, claim and recovery: no console, no wallet, one action per page. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
