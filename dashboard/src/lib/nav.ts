import { viewPathOf } from "./mandate-path";

/**
 * The views of one mandate, in navigation order and in three groups: what needs the owner, the agent's
 * work, and the records. Each href is the view's path inside the mandate (`/rules` is `/m/<id>/rules`,
 * #95). To add a view: add an entry here and in `MANDATE_VIEWS`, a route folder under
 * src/app/(console)/m/[mandate]/<slug>/, and a feature folder under src/features/<slug>/.
 */
export type NavIcon = "home" | "approvals" | "activity" | "rules" | "hedge" | "payments" | "audit" | "setup";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export const consoleNavGroups: readonly (readonly NavItem[])[] = [
  [
    { href: "/", label: "Overview", icon: "home" },
    { href: "/approvals", label: "Approvals", icon: "approvals" },
  ],
  [
    { href: "/activity", label: "Activity", icon: "activity" },
    { href: "/rules", label: "Rules", icon: "rules" },
    { href: "/hedge", label: "Hedge", icon: "hedge" },
  ],
  [
    { href: "/payments", label: "Payments", icon: "payments" },
    { href: "/audit", label: "Audit", icon: "audit" },
    { href: "/setup", label: "Setup", icon: "setup" },
  ],
];

/** Whether `href`, a view path, is the view `pathname` shows (inside its mandate). */
export function isActive(pathname: string, href: string): boolean {
  const view = viewPathOf(pathname)?.path ?? pathname;
  return href === "/" ? view === "/" : view === href || view.startsWith(`${href}/`);
}
