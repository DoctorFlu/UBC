import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/** Writes docs/screenshots/: the page at phone and desktop width, and the gate in each verdict. */
const outDir = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

const schemes = ["light", "dark"] as const;
const viewports = [
  { name: "phone", width: 360, height: 780 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function ready(page: Page) {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
}

for (const scheme of schemes) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${scheme}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.name === "phone" ? 2 : 1,
        hasTouch: viewport.name === "phone",
        reducedMotion: "reduce",
      });

      test("page", async ({ page }) => {
        await ready(page);
        await page.screenshot({
          path: `${outDir}page-${viewport.width.toString()}-${scheme}.png`,
          fullPage: true,
          animations: "disabled",
        });
      });
    });
  }

  test.describe(`gate, ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

    test("every verdict", async ({ page }) => {
      await ready(page);
      const gate = page.getByTestId("gate");
      const verdict = page.getByTestId("verdict");
      const amount = page.getByLabel("Exact amount");
      const setAmount = async (value: string) => {
        await amount.fill(value);
        await amount.press("Enter");
      };
      const shoot = (state: string) =>
        gate.screenshot({ path: `${outDir}gate-${state}-${scheme}.png`, animations: "disabled" });

      await expect(verdict).toContainText("Approved");
      await shoot("approved");

      await setAmount("22");
      await expect(verdict).toContainText("Held for your signature");
      await shoot("held");

      await setAmount("30");
      await expect(verdict).toContainText("over max trade size");
      await shoot("rejected-max-trade");

      await setAmount("18");
      await page.getByRole("radio", { name: "Sports" }).click();
      await expect(verdict).toContainText("category not allowed");
      await shoot("rejected-market");

      await page.getByRole("radio", { name: "Crypto" }).click();
      await page.getByRole("switch", { name: "Pause agent" }).click();
      await expect(verdict).toContainText("agent paused");
      await shoot("rejected-paused");
    });
  });
}
