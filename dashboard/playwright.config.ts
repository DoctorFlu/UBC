import { defineConfig, devices } from "@playwright/test";

/**
 * Headless Chromium only. Install it once with `npx playwright install chromium`.
 *
 * `smoke` runs against `next dev` (fast to start). `screenshots` sets E2E_SERVER=prod and runs
 * against `next build && next start`, so the committed images show the production build.
 * Both enable the dev signer, which connects the public anvil test owner without a wallet.
 *
 * Never run this while another `next dev` serves this folder: `next build` would clobber it.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
// localhost, not 127.0.0.1: the dev server's HMR socket only accepts the host it was started on.
const baseURL = `http://localhost:${PORT.toString()}`;
const prod = process.env.E2E_SERVER === "prod";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/warm-up.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  projects: [
    { name: "smoke", testMatch: /smoke\.spec\.ts/ },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: prod
      ? `npx next build && npx next start --port ${PORT.toString()}`
      : `npx next dev --port ${PORT.toString()}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NEXT_PUBLIC_DEV_SIGNER: "1" },
  },
});
