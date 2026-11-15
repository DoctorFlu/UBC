import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{shared,gemini,planner,agent,signals,devchain}/**/*.test.ts"],
    passWithNoTests: true,
    // Compiles the devchain reference contract once, before test files start their own anvil.
    globalSetup: ["devchain/test/global-setup.ts"],
    testTimeout: 20_000,
  },
});
