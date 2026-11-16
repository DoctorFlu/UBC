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

// The smoke suite only reads the seeded demo, so its tests can run in parallel. Owner actions (approve,
// reject, pause) change the chain and live in live.spec.ts, which has a chain of its own.

/** The 404 status itself is logged by Chrome; that is the expected outcome, not a problem. */
const notFoundResponse = /the server responded with a status of 404/;

test.describe("public pages", () => {
  test("an unknown agent address is a 404", async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto("/agent/not-an-address");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Nothing at this address")).toBeVisible();
    expect(problems.filter((problem) => !notFoundResponse.test(problem))).toEqual([]);
  });

  test("an address that is not the contract's agent is a 404", async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto(`/agent/${OWNER_ADDRESS}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Nothing at this address")).toBeVisible();
    expect(problems.filter((problem) => !notFoundResponse.test(problem))).toEqual([]);
  });
});

test.describe("seeded demo", () => {
  test("the tag beside the logo names the chain the console resolved", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByTestId("network-tag").filter({ visible: true })).toHaveText("Local");
    await expect(page.locator("main").getByText("Local dev chain", { exact: true })).toBeVisible();
  });

  test("the reason the agent linked offchain checks out", async ({ page }) => {
    await page.goto("/activity/0");
    const sealed = page.getByTestId("sealed-reason");
    await expect(page.getByText("Recorded offchain", { exact: true })).toBeVisible();
    await expect(sealed).toContainText("Verified");
    await expect(sealed).toContainText("The $65,000 rung pays first");
  });

  test("an intent without a link says no reason was recorded", async ({ page }) => {
    await page.goto("/activity/1");
    await expect(page.getByTestId("sealed-reason")).toContainText("No reason recorded");
  });

  test("the audit counts blocked intents by the contract's reason", async ({ page }) => {
    await page.goto("/audit");
    const blocked = page.locator("main");
    await expect(blocked.getByText("over max trade size", { exact: true }).first()).toBeVisible();
    await expect(blocked.getByText("category not allowed", { exact: true }).first()).toBeVisible();
  });
});
