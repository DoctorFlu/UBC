/**
 * The console's views, in navigation order and in three groups: what needs the owner, the agent's
 * work, and the records. To add a view: add an entry here, a route folder under
 * src/app/(console)/<slug>/, and a feature folder under src/features/<slug>/.
 */
export type NavIcon = "home" | "approvals" | "activity" | "rules" | "hedge" | "payments" | "audit" | "setup";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export const consoleNavGroups: readonly (readonly NavItem[])[] = [
  [
    { href: "/", label: "Home", icon: "home" },
    { href: "/approvals", label: "Approvals", icon: "approvals" },
  ],
  [
    { href: "/activity", label: "Activity", icon: "activity" },
    { href: "/mandate", label: "Rules", icon: "rules" },
    { href: "/hedge", label: "Hedge", icon: "hedge" },
  ],
  [
    { href: "/payments", label: "Payments", icon: "payments" },
    { href: "/audit", label: "Audit", icon: "audit" },
    { href: "/setup", label: "Setup", icon: "setup" },
  ],
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
