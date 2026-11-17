import { defineConfig, devices } from "@playwright/test";

/**
 * Headless Chromium against the real static export: `next build` writes `out/`, and scripts/serve.ts
 * serves it the way a plain static host does. Install the browser once with
 * `npx playwright install chromium`.
 *
 * - `phone-*` and `desktop-*` run e2e/site.spec.ts at 360 and 1440 px in each colour scheme.
 * - `icons` runs e2e/icons.spec.ts once: the icons and the link preview image.
 * - `screenshots` writes docs/screenshots/ (`npm run screenshots -w @mandate/site`).
 *
 * The build bakes in example settings, so the tests prove the links follow them. Never run this while
 * `next dev` serves this folder: `next build` would clobber its `.next`.
 */
const PORT = Number(process.env.E2E_SITE_PORT ?? 3200);
const baseURL = `http://localhost:${PORT.toString()}`;

export const TEST_APP_URL = "https://app.example.test";
export const TEST_SITE_URL = "https://site.example.test";
export const TEST_SCORECARD_AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const phone = { ...devices["Pixel 7"], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 };
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "phone-light", testMatch: /site\.spec\.ts/, use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", testMatch: /site\.spec\.ts/, use: { ...phone, colorScheme: "dark" } },
    { name: "desktop-light", testMatch: /site\.spec\.ts/, use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", testMatch: /site\.spec\.ts/, use: { ...desktop, colorScheme: "dark" } },
    { name: "icons", testMatch: /icons\.spec\.ts/, use: desktop },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx next build && npx tsx scripts/serve.ts --port ${PORT.toString()}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_APP_URL: TEST_APP_URL,
      NEXT_PUBLIC_SITE_URL: TEST_SITE_URL,
      NEXT_PUBLIC_SCORECARD_AGENT: TEST_SCORECARD_AGENT,
      NEXT_PUBLIC_REPO_URL: "",
    },
  },
});
