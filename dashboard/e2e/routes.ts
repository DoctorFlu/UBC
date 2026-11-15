/** Every page the dashboard serves, shared by the smoke test and the screenshot run. */
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
  { name: "overview", path: "/", heading: "Overview", console: true },
  { name: "activity", path: "/activity", heading: "Activity", console: true },
  { name: "mandate", path: "/mandate", heading: "Mandate", console: true },
  { name: "hedge", path: "/hedge", heading: "Hedge", console: true },
  { name: "payments", path: "/payments", heading: "Payments", console: true },
  { name: "audit", path: "/audit", heading: "Audit", console: true },
  { name: "setup", path: "/setup", heading: "Setup", console: true },
  { name: "scorecard", path: `/agent/${AGENT_ADDRESS}`, heading: "Grok Bot", console: false },
  { name: "components", path: "/dev/components", heading: "Components", console: false },
];

export const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export const schemes = ["light", "dark"] as const;
