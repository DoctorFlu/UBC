import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The dashboard imports its own modules through the "@/" alias (see dashboard/tsconfig.json).
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("./dashboard/src/", import.meta.url)) },
      // Next.js resolves `server-only` itself; under vitest the dashboard's server modules just load.
      {
        find: /^server-only$/,
        replacement: fileURLToPath(
          new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: [
      "{shared,gemini,planner,agent,signals,devchain,streams,redteam}/**/*.test.ts",
      "dashboard/src/**/*.test.ts",
      "deploy/test/**/*.test.ts",
    ],
    passWithNoTests: true,
    // Compiles the devchain reference contract once, before test files start their own anvil.
    globalSetup: ["devchain/test/global-setup.ts"],
    testTimeout: 20_000,
    // Hooks start a local chain (anvil) and deploy the contract. That takes about a second on an idle
    // machine, but vitest's default of 10 s was missed on a busy one (2026-11-15, load above 100).
    hookTimeout: 60_000,
  },
});
