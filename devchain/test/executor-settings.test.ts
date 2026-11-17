import { describe, expect, it } from "vitest";
import { executorSettings } from "../src/executor-settings";

describe("executorSettings", () => {
  it("keeps the laptop defaults when nothing is set, blank values included", () => {
    const defaults = {
      fillDelayMs: 1_500,
      pollingIntervalMs: undefined,
      settleIntervalMs: 60_000,
      consoleUrl: "http://localhost:3000",
      venue: "simulated",
      orderTtlMs: 600_000,
      discoveryIntervalMs: 15_000,
    };
    expect(executorSettings({})).toEqual(defaults);
    expect(
      executorSettings({
        SIM_EXECUTOR_DELAY_MS: " ",
        SIM_EXECUTOR_POLL_MS: "",
        EXECUTOR_SETTLE_MS: "",
        CONSOLE_URL: " ",
        EXECUTOR_VENUE: "",
        EXECUTOR_ORDER_TTL_MS: "",
        EXECUTOR_DISCOVERY_MS: "",
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
        EXECUTOR_VENUE: "Gemini",
        EXECUTOR_ORDER_TTL_MS: "120000",
        EXECUTOR_DISCOVERY_MS: "5000",
      }),
    ).toEqual({
      fillDelayMs: 0,
      pollingIntervalMs: 2_000,
      settleIntervalMs: 30_000,
      consoleUrl: "http://console:3000",
      venue: "gemini",
      orderTtlMs: 120_000,
      discoveryIntervalMs: 5_000,
    });
  });

  it("refuses a value that is not a sensible whole number of milliseconds", () => {
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "1s" })).toThrow(/SIM_EXECUTOR_POLL_MS must be/);
    expect(() => executorSettings({ SIM_EXECUTOR_POLL_MS: "10" })).toThrow(/at least 50/);
    expect(() => executorSettings({ SIM_EXECUTOR_DELAY_MS: "-1" })).toThrow(/SIM_EXECUTOR_DELAY_MS must be/);
    expect(() => executorSettings({ EXECUTOR_SETTLE_MS: "500" })).toThrow(/at least 1000/);
    expect(() => executorSettings({ CONSOLE_URL: "console" })).toThrow(/CONSOLE_URL must be a URL/);
    expect(() => executorSettings({ EXECUTOR_VENUE: "kalshi" })).toThrow(/simulated or gemini/);
    expect(() => executorSettings({ EXECUTOR_ORDER_TTL_MS: "500" })).toThrow(/at least 10000/);
  });
});
