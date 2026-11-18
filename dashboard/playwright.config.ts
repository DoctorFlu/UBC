import { defineConfig, devices } from "@playwright/test";

import { suitePaths } from "./e2e/support/chain";
import { E2E_MASTER_KEY, E2E_SERVICE_TOKEN } from "./e2e/support/console";
import { SUITE_GEMINI_PORT } from "./e2e/support/fake-gemini";
import { ownerStatePath } from "./e2e/support/session";

/**
 * Headless Chromium only. Install it once with `npx playwright install chromium`.
 *
 * Every suite runs against its own local chain (anvil, the production Policy contract) and its own
 * console data directory under `.data/e2e-<suite>/`, so nothing here touches Arc or a developer's data.
 *
 * - `smoke` runs against `next dev` (fast to start) on a chain seeded with the demo history.
 * - `screenshots` sets E2E_SERVER=prod and runs against `next build && next start` on the same seed,
 *   so the committed images show the production build.
 * - `prod` (E2E_SERVER=prod) checks what only the production build does, such as prefetching a route's
 *   loading state, on the screenshots seed.
 * - `live` (E2E_SUITE=live) starts and restarts its own chain and console from the spec, so Playwright
 *   starts no server for it. It runs after `smoke` in `npm run e2e`, never at the same time, because
 *   both use this folder's `.next`.
 *
 * All of them enable the dev signer, which connects the public anvil test owner without a wallet.
 * Never run this while another `next dev` serves this folder: `next build` would clobber it.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const CHAIN_PORT = Number(process.env.E2E_CHAIN_PORT ?? 8645);
// A local stand-in for Gemini's public API, answering from recorded responses (e2e/support/fake-gemini.ts).
const GEMINI_PORT = SUITE_GEMINI_PORT;
// localhost, not 127.0.0.1: the dev server's HMR socket only accepts the host it was started on.
const baseURL = `http://localhost:${PORT.toString()}`;
const prod = process.env.E2E_SERVER === "prod";
const live = process.env.E2E_SUITE === "live";
const suite = prod ? "screenshots" : "smoke";
const paths = suitePaths(suite);
/** The owner's session, which the warm-up saves when it claims the first workspace (e2e/support/session.ts). */
const owner = ownerStatePath(baseURL);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/warm-up.ts",
  fullyParallel: !live,
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
    { name: "smoke", testMatch: /(smoke|shell|icons|accounts)\.spec\.ts/, use: { storageState: owner } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { storageState: owner } },
    { name: "prod", testMatch: /prod\.spec\.ts/, use: { storageState: owner } },
    // One worker: each spec starts its own `next dev` on this folder's `.next`, so they run one after the other.
    { name: "live", testMatch: /(live|wake|wallet)\.spec\.ts/, timeout: 240_000, workers: 1 },
  ],
  webServer: live
    ? []
    : [
        {
          name: "chain",
          command: `npx tsx e2e/support/serve-chain.ts --suite ${suite} --port ${CHAIN_PORT.toString()} --seed demo`,
          port: CHAIN_PORT,
          wait: { stdout: /e2e chain ready/ },
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: "pipe",
        },
        {
          name: "gemini",
          command: `npx tsx e2e/support/serve-gemini.ts --port ${GEMINI_PORT.toString()}`,
          port: GEMINI_PORT,
          wait: { stdout: /fake gemini ready/ },
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: "pipe",
        },
        {
          name: "console",
          command: prod
            ? `npx next build && npx next start --port ${PORT.toString()}`
            : `npx next dev --port ${PORT.toString()}`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 240_000,
          env: {
            NEXT_PUBLIC_DEV_SIGNER: "1",
            // The suite's own chain, whatever the shell has configured.
            POLICY_ADDRESS: "",
            POLICY_DEPLOY_BLOCK: "",
            CONSOLE_EVENT_SOURCE: "rpc",
            POLICY_DEPLOYMENT_FILE: paths.deploymentFile,
            CONSOLE_DATA_DIR: paths.dataDir,
            CONSOLE_SERVICE_TOKEN: E2E_SERVICE_TOKEN,
            // The production build runs as production: it needs a master key, and sign-up needs an invite.
            CONSOLE_MASTER_KEY: E2E_MASTER_KEY,
            CONSOLE_URL: baseURL,
            MCP_PUBLIC_URL: "https://mcp.example.test/mcp",
            // Never the real Gemini: the suite's quotes come from recorded responses.
            GEMINI_API_URL: `http://127.0.0.1:${GEMINI_PORT.toString()}`,
            // `next dev` starts without the compile cache an earlier run left: see next.config.ts.
            NEXT_DEV_CACHE: "off",
          },
        },
      ],
});
