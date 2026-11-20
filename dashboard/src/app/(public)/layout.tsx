import type { ReactNode } from "react";

import { PublicFrame } from "@/components/shell/PublicFrame";

/** Public pages are wallet-free: this group never mounts the wallet provider. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicFrame note="Public dashboard">{children}</PublicFrame>;
}
