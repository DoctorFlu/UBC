import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { firstMandatePath } from "./support/console";
import { watchConsole } from "./support/problems";

/**
 * Behaviour only the production build has, run with `npm run e2e:prod` (E2E_SERVER=prod, on the
 * screenshots seed). `next dev` never prefetches, so a route's loading.tsx shows only here.
 */
test.beforeAll(() => {
  if (process.env.E2E_SERVER !== "prod") {
    throw new Error("These tests need the production build: run them with npm run e2e:prod.");
  }
});

test("the console keeps an idle connection open longer than Caddy reuses one", async ({ request }) => {
  // Caddy reuses an idle connection for up to 2 minutes; the hosted console sets the same 130 s
  // (KEEP_ALIVE_TIMEOUT in deploy/Dockerfile), so a reused connection is never one Node has closed.
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(response.headers()["keep-alive"]).toBe("timeout=130");
});

test.describe("route loading fallback", () => {
  test("shows while a page is on its way, keeps the shell usable, and gives way to the page", async ({
    page,
    baseURL,
  }) => {
    const problems = watchConsole(page);
    await page.goto(await firstMandatePath(baseURL ?? ""));
    await expect(page.locator("html[data-page-hydrated]")).toBeAttached();
    // Let the sidebar's links prefetch their routes' loading states, as they do for the owner.
    await page.waitForLoadState("networkidle");
    // Behind the proxy a page can take seconds to arrive: hold the Audit page's server response.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Only the navigation itself: the prefetch that brought loading.tsx along has already arrived.
    const audit = await firstMandatePath(baseURL ?? "", "/audit");
    await page.route(
      (url) => url.pathname === audit,
      async (route) => {
        const headers = route.request().headers();
        const prefetch = "next-router-prefetch" in headers || "next-router-segment-prefetch" in headers;
        if (headers["rsc"] === "1" && !prefetch) await held;
        await route.continue().catch(() => {});
      },
    );
    await page.getByRole("navigation").getByRole("link", { name: "Audit", exact: true }).click();

    // The route's loading.tsx: a busy frame with a status, and nothing of the page yet.
    const loading = page.getByRole("heading", { level: 1, name: "Loading" });
    await expect(loading).toBeVisible();
    await expect(page.locator('[aria-busy="true"]').filter({ has: loading })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading Loading" })).toBeAttached();
    await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);

    // The shell stays usable meanwhile: the Advanced view switch still answers.
    const toggle = page.getByRole("switch", { name: "Advanced view" });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    release();
    await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
    await expect(loading).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});
