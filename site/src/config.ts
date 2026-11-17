/** Public build-time settings, pinned in next.config.ts. */

/** The console's origin: "Launch app" and the scorecard link go there. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** The agent whose public scorecard the page links to. */
export const SCORECARD_AGENT = process.env.NEXT_PUBLIC_SCORECARD_AGENT ?? "";

export const SCORECARD_URL = `${APP_URL}/agent/${SCORECARD_AGENT}`;

/** The repository link in the footer; empty (the default) hides it, so publishing it is the owner's choice. */
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? "";
