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
      "{shared,gemini,planner,agent,signals,devchain,streams}/**/*.test.ts",
      "dashboard/src/**/*.test.ts",
    ],
    passWithNoTests: true,
    // Compiles the devchain reference contract once, before test files start their own anvil.
    globalSetup: ["devchain/test/global-setup.ts"],
    testTimeout: 20_000,
  },
});
