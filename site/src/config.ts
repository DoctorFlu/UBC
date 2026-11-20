/** Public build-time settings, pinned in next.config.ts. */

/** The console's origin: "Launch app" and the public dashboard link go there. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** The agent whose public dashboard the page links to. */
export const PUBLIC_DASHBOARD_AGENT = process.env.NEXT_PUBLIC_DASHBOARD_AGENT ?? "";

export const PUBLIC_DASHBOARD_URL = `${APP_URL}/agent/${PUBLIC_DASHBOARD_AGENT}`;

/** The repository link in the footer; empty (the default) hides it, so publishing it is the owner's choice. */
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? "";

/** The page's own public origin, which link previews resolve the preview image against. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
