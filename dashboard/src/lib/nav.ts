/**
 * The console's views, in navigation order. To add a view: add an entry here, a route folder
 * under src/app/(console)/<slug>/, and a feature folder under src/features/<slug>/.
 */
export type NavIcon = "overview" | "activity" | "mandate" | "hedge" | "payments" | "audit" | "setup";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** One line for the view's header and for screen readers. */
  description: string;
}

export const consoleNav: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "overview", description: "Limits, load, and what needs you." },
  {
    href: "/activity",
    label: "Activity",
    icon: "activity",
    description: "Every intent the agent sends, as the Policy contract decides it.",
  },
  {
    href: "/mandate",
    label: "Mandate",
    icon: "mandate",
    description: "The rules the agent runs under, a backtest of changes, and the agent's requests.",
  },
  {
    href: "/hedge",
    label: "Hedge",
    icon: "hedge",
    description: "Your holdings, the contract ladder, and the payoff.",
  },
  {
    href: "/payments",
    label: "Payments",
    icon: "payments",
    description: "What the agent paid for over x402.",
  },
  { href: "/audit", label: "Audit", icon: "audit", description: "Every intent and decision, read from Arc." },
  { href: "/setup", label: "Setup", icon: "setup", description: "Pair Grok Bot and finish setting up." },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
