import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The dashboard imports its own modules through the "@/" alias (see dashboard/tsconfig.json).
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./dashboard/src/", import.meta.url)) }],
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
