import type { Page, Response } from "@playwright/test";

/**
 * Waits until the page has hydrated: its header marks `<html data-page-hydrated>` once React runs the page
 * (`src/lib/page-hydration.ts`). `page.goto` waits only for the load event, and on a busy machine React can
 * attach its handlers after that, so a click sent in between lands on server HTML and does nothing.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.locator("html[data-page-hydrated]").waitFor({ state: "attached" });
}

/**
 * Opens `url` and waits for the page to hydrate. Every test that acts on a page right after opening it
 * opens it this way, so a click never races React.
 */
export async function gotoHydrated(
  page: Page,
  url: string,
  options?: Parameters<Page["goto"]>[1],
): Promise<Response | null> {
  const response = await page.goto(url, options);
  await waitForHydration(page);
  return response;
}
