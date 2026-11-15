import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{shared,gemini,planner,agent,signals,devchain,streams}/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
