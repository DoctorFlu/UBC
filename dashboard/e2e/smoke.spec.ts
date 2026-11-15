import { type Page, expect, test } from "@playwright/test";

import { OWNER_ADDRESS, routes, schemes, viewports } from "./routes";

/**
 * Chrome's "preloaded but not used within a few seconds" hint is a timing report, not a defect:
 * it fires when a loaded machine makes `next dev` slow to serve a page. Everything else counts.
 */
const timingHint = /was preloaded using link preload but not used within a few seconds/;

/** Collects console errors, warnings (hydration mismatches are warnings) and uncaught errors. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (timingHint.test(message.text())) return;
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

for (const scheme of schemes) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${scheme}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.name === "phone",
      });

      for (const route of routes) {
        test(`${route.name} renders cleanly`, async ({ page }) => {
          const problems = watchConsole(page);
          await page.goto(route.path);
          await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
          // No horizontal scroll at any width.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          // Tables fit their card on a desktop; they scroll sideways only as a last resort.
          if (viewport.name === "desktop") {
            const clipped = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>("main [role=region]")]
                .filter((region) => region.offsetParent !== null && region.scrollWidth > region.clientWidth)
                .map((region) => region.getAttribute("aria-labelledby") ?? "table"),
            );
            expect(clipped).toEqual([]);
          }
          if (route.console) {
            // The badge renders once for wide screens and once for phones; one of them shows.
            await expect(page.getByTestId("dev-signer-badge").filter({ visible: true })).toHaveCount(1);
          } else {
            await expect(page.getByTestId("owner-address")).toHaveCount(0);
          }
          await page.waitForLoadState("networkidle");
          expect(problems).toEqual([]);
        });
      }

      test("the dev signer shows the connected owner", async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto("/");
        if (viewport.name === "phone") {
          await page.getByRole("button", { name: "Open menu" }).click();
        }
        const owner = page.locator(`[data-testid="owner-address"][data-address="${OWNER_ADDRESS}"]`).filter({
          visible: true,
        });
        await expect(owner).toBeVisible();
        await expect(owner).toContainText("0xf39F…2266");
        expect(problems).toEqual([]);
      });
    });
  }
}

test.describe("phone flows", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("approve a held intent by pressing twice", async ({ page }) => {
    await page.goto("/activity");
    const approve = page.getByRole("button", { name: /^Approve \$28\.80/ }).filter({ visible: true });
    await approve.first().click();
    await approve.first().click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Approved");
  });

  test("pause the agent with the keyboard alternative", async ({ page }) => {
    await page.goto("/");
    const isolator = page.getByRole("button", { name: /Pause/ }).filter({ visible: true }).first();
    await isolator.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("paused-banner")).toBeVisible();
  });

  test("an unknown agent address is a 404", async ({ page }) => {
    const response = await page.goto("/agent/not-an-address");
    expect(response?.status()).toBe(404);
  });
});
