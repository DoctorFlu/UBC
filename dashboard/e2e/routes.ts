import { snapshot } from "./support/console";

/** Every page the dashboard serves, shared by the smoke test and the screenshot run. */
/** Stands for the latest plan's evidence page until `routePath` resolves it. */
const LATEST_PLAN = "/hedge/plans/{latest}";

export const AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const OWNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export interface RouteCase {
  name: string;
  path: string;
  heading: string;
  /** Console routes render the shell and the wallet; public ones do not. */
  console: boolean;
}

export const routes: readonly RouteCase[] = [
  { name: "home", path: "/", heading: "Home", console: true },
  { name: "approvals", path: "/approvals", heading: "Approvals", console: true },
  { name: "activity", path: "/activity", heading: "Activity", console: true },
  { name: "intent", path: "/activity/0", heading: "Intent #0", console: true },
  { name: "mandate", path: "/mandate", heading: "Mandate", console: true },
  { name: "hedge", path: "/hedge", heading: "Hedge", console: true },
  // The agent's latest plan, whose id the planner derives from its inputs: see `routePath`.
  { name: "evidence", path: LATEST_PLAN, heading: "Evidence chain", console: true },
  { name: "payments", path: "/payments", heading: "Payments", console: true },
  { name: "audit", path: "/audit", heading: "Audit", console: true },
  { name: "setup", path: "/setup", heading: "Setup", console: true },
  { name: "pair", path: `/setup/pair/${AGENT_ADDRESS}`, heading: "Confirm the agent", console: true },
  { name: "scorecard", path: `/agent/${AGENT_ADDRESS}`, heading: "Grok Bot", console: false },
  { name: "components", path: "/dev/components", heading: "Components", console: false },
];

/** The path of a route, with the latest stored plan's id in place of `LATEST_PLAN`. */
export async function routePath(route: RouteCase, baseURL: string): Promise<string> {
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
