import { firstMandatePath, snapshot } from "./support/console";

/** Every page the dashboard serves, shared by the smoke test and the screenshot run. */
/** Stands for the latest plan's evidence page until `routePath` resolves it. */
const LATEST_PLAN = "/hedge/plans/{latest}";
/** Stands for the first mandate's Overview (`/m/<id>`, #95) until `routePath` resolves it. */
const OVERVIEW = "/m/{first}";

export const AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const OWNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export interface RouteCase {
  name: string;
  path: string;
  heading: string;
  /** A mandate's pages render the shell and the wallet; the workspace's and public ones do not. */
  console: boolean;
}

export const routes: readonly RouteCase[] = [
  { name: "home", path: "/", heading: "Home", console: false },
  { name: "new-mandate", path: "/mandates/new", heading: "New mandate", console: false },
  // Old links (`/approvals`) open the first mandate's pages; its Overview has no old link: see `routePath`.
  { name: "overview", path: OVERVIEW, heading: "Overview", console: true },
  { name: "approvals", path: "/approvals", heading: "Approvals", console: true },
  { name: "activity", path: "/activity", heading: "Activity", console: true },
  { name: "intent", path: "/activity/0", heading: "Intent #0", console: true },
  { name: "rules", path: "/rules", heading: "Rules", console: true },
  { name: "hedge", path: "/hedge", heading: "Hedge", console: true },
  // The agent's latest plan, whose id the planner derives from its inputs: see `routePath`.
  { name: "evidence", path: LATEST_PLAN, heading: "Evidence chain", console: true },
  { name: "payments", path: "/payments", heading: "Payments", console: true },
  { name: "audit", path: "/audit", heading: "Audit", console: true },
  { name: "setup", path: "/setup", heading: "Setup", console: true },
  { name: "pair", path: `/setup/pair/${AGENT_ADDRESS}`, heading: "Confirm the agent", console: true },
  { name: "public-dashboard", path: `/agent/${AGENT_ADDRESS}`, heading: "Grok Bot", console: false },
  { name: "components", path: "/dev/components", heading: "Components", console: false },
];

/** The path of a route, with the first mandate's id and the latest stored plan's id filled in. */
export async function routePath(route: RouteCase, baseURL: string): Promise<string> {
  if (route.path === OVERVIEW) return firstMandatePath(baseURL);
  if (route.path !== LATEST_PLAN) return route.path;
  const plan = (await snapshot(baseURL)).offchain.plans[0];
  if (!plan) throw new Error("the warm-up posted no plan");
  return `/hedge/plans/${encodeURIComponent(plan.planId)}`;
}

export const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export const schemes = ["light", "dark"] as const;

/**
 * Laptop windows with the sidebar open, where a table or a row of figures is tightest: Home and Activity
 * are also shot at these, so a wrapped order line or an orphaned figure shows in review.
 */
export const laptopWidths = [1024, 1084, 1280, 1470] as const;
