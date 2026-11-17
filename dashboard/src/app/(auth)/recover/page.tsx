import type { Metadata } from "next";

import { RecoverView } from "@/features/auth/AuthViews";

export const metadata: Metadata = { title: "Use a recovery code" };

export default function RecoverPage() {
  return <RecoverView />;
}
