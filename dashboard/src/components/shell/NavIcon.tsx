import {
  Activity,
  BookOpenCheck,
  Cable,
  LayoutDashboard,
  type LucideIcon,
  Receipt,
  ScrollText,
  ShieldHalf,
} from "lucide-react";

import type { NavIcon as NavIconName } from "@/lib/nav";

const icons: Record<NavIconName, LucideIcon> = {
  overview: LayoutDashboard,
  activity: Activity,
  mandate: ScrollText,
  hedge: ShieldHalf,
  payments: Receipt,
  audit: BookOpenCheck,
  setup: Cable,
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = icons[name];
  return <Icon className={className} aria-hidden strokeWidth={1.75} />;
}
