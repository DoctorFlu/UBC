import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { routePath, routes, schemes, viewports } from "./routes";

/**
 * Writes docs/screenshots/<route>-<width>-<scheme>.png for every route, and <...>-advanced.png for every
 * console route in Advanced view. Run with `npm run screenshots`.
 */
const outDir = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

for (const scheme of schemes) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${scheme}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.name === "phone" ? 2 : 1,
        hasTouch: viewport.name === "phone",
      });

      const cases = [
        ...routes.map((route) => ({ route, advanced: false })),
        ...routes.filter((route) => route.console).map((route) => ({ route, advanced: true })),
      ];
      for (const { route, advanced } of cases) {
        test(`${route.name}${advanced ? ", Advanced view" : ""}`, async ({ page, context, baseURL }) => {
          if (advanced)
            await context.addCookies([{ name: "mandate-advanced", value: "on", url: baseURL ?? "" }]);
          await page.goto(await routePath(route, baseURL ?? ""));
          await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
          if (route.console) {
            await expect(page.getByTestId("owner-address").filter({ visible: true })).toHaveCount(
              viewport.name === "phone" ? 0 : 1,
            );
            await expect(page.getByTestId("dev-signer-badge").filter({ visible: true })).toHaveCount(1);
          }
          await page.waitForLoadState("networkidle");
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: `${outDir}${route.name}-${viewport.width.toString()}-${scheme}${advanced ? "-advanced" : ""}.png`,
            fullPage: true,
            animations: "disabled",
          });
        });
      }
    });
  }
}
