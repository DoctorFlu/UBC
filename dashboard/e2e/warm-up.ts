import type { FullConfig } from "@playwright/test";

import { routes } from "./routes";

/**
 * `next dev` compiles each route on its first request. Tests that hit a cold route in parallel
 * can wait long enough for Chrome to log "preloaded but not used" warnings, which the smoke test
 * rightly treats as failures. Compiling every route once, in order, before the tests removes that.
 */
export default async function warmUp(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  for (const route of routes) {
    const response = await fetch(new URL(route.path, baseURL));
    await response.arrayBuffer();
  }
}
