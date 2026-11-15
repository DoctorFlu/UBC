import type { ReactNode } from "react";

import { PublicFrame } from "@/components/shell/PublicFrame";

/** Developer pages (the component gallery), outside the console and its wallet provider. */
export default function DevLayout({ children }: { children: ReactNode }) {
  return <PublicFrame note="Components">{children}</PublicFrame>;
}
