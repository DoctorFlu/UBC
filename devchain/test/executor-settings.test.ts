import { describe, expect, it } from "vitest";
import { executorSettings } from "../src/executor-settings";

describe("executorSettings", () => {
  it("keeps the laptop defaults when nothing is set, blank values included", () => {
    const defaults = {
      fillDelayMs: 1_500,
      pollingIntervalMs: undefined,
      settleIntervalMs: 60_000,
      consoleUrl: "http://localhost:3000",
    };
    expect(executorSettings({})).toEqual(defaults);
    expect(
      executorSettings({
        SIM_EXECUTOR_DELAY_MS: " ",
        SIM_EXECUTOR_POLL_MS: "",
        EXECUTOR_SETTLE_MS: "",
        CONSOLE_URL: " ",
      }),
    ).toEqual(defaults);
  });

  it("reads every setting", () => {
    expect(
      executorSettings({
        SIM_EXECUTOR_DELAY_MS: "0",
        SIM_EXECUTOR_POLL_MS: "2000",
        EXECUTOR_SETTLE_MS: "30000",
        CONSOLE_URL: "http://console:3000",
      }),
    ).toEqual({
      fillDelayMs: 0,
      pollingIntervalMs: 2_000,
      settleIntervalMs: 30_000,
      consoleUrl: "http://console:3000",
    });
  });

  it("refuses a value that is not a sensible whole number of milliseconds", () => {
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "1s" })).toThrow(/SIM_EXECUTOR_POLL_MS must be/);
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "10" })).toThrow(/at least 50/);
    expect(() => executorSettings({ SIM_EXECUTOR_DELAY_MS: "-1" })).toThrow(/SIM_EXECUTOR_DELAY_MS must be/);
    expect(() => executorSettings({ EXECUTOR_SETTLE_MS: "500" })).toThrow(/at least 1000/);
    expect(() => executorSettings({ CONSOLE_URL: "console" })).toThrow(/CONSOLE_URL must be a URL/);
  });
});
