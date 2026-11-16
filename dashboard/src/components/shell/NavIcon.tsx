import {
  Activity,
  BookOpenCheck,
  Cable,
  Gauge,
  Inbox,
  type LucideIcon,
  Receipt,
  ScrollText,
  ShieldHalf,
} from "lucide-react";

import type { NavIcon as NavIconName } from "@/lib/nav";

const icons: Record<NavIconName, LucideIcon> = {
  home: Gauge,
  approvals: Inbox,
  activity: Activity,
  rules: ScrollText,
  hedge: ShieldHalf,
  payments: Receipt,
  audit: BookOpenCheck,
  setup: Cable,
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = icons[name];
  return <Icon className={className} aria-hidden nonScalingStroke strokeWidth={1.5} />;
}
