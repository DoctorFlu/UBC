import { describe, expect, it } from "vitest";
import { executorSettings } from "../src/executor-settings";

describe("executorSettings", () => {
  it("keeps the laptop defaults when nothing is set, blank values included", () => {
    expect(executorSettings({})).toEqual({ fillDelayMs: 1_500, pollingIntervalMs: undefined });
    expect(executorSettings({ SIM_EXECUTOR_DELAY_MS: " ", SIM_EXECUTOR_POLL_MS: "" })).toEqual({
      fillDelayMs: 1_500,
      pollingIntervalMs: undefined,
    });
  });

  it("reads both settings", () => {
    expect(executorSettings({ SIM_EXECUTOR_DELAY_MS: "0", SIM_EXECUTOR_POLL_MS: "2000" })).toEqual({
      fillDelayMs: 0,
      pollingIntervalMs: 2_000,
    });
  });

  it("refuses a value that is not a sensible whole number of milliseconds", () => {
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "1s" })).toThrow(/SIM_EXECUTOR_POLL_MS must be/);
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "10" })).toThrow(/at least 50/);
    expect(() => executorSettings({ SIM_EXECUTOR_DELAY_MS: "-1" })).toThrow(/SIM_EXECUTOR_DELAY_MS must be/);
  });
});
