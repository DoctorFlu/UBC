import { inspect } from "node:util";

import { WAKE_DEFAULT_DAILY_CAP } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { DEFAULT_PRICE_CHECK_MS, readConsoleConfig, readWakeConfig } from "./config";

const URL_WITH_SECRET = "https://hooks.example.test/routines/secret-path-1/run";

describe("readWakeConfig", () => {
  it("is off, with the defaults, when nothing is set", () => {
    expect(readWakeConfig({})).toEqual({
      target: null,
      offReason: "Set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY on the console to the routine's webhook.",
      dailyCap: WAKE_DEFAULT_DAILY_CAP,
      priceCheckMs: DEFAULT_PRICE_CHECK_MS,
      testClock: false,
    });
  });

  it("is on with both, and never shows either value", () => {
    const config = readConsoleConfig({ GROK_WEBHOOK_URL: URL_WITH_SECRET, GROK_WEBHOOK_KEY: "key-value-1" });
    expect(config.wake.target?.reveal()).toEqual({ url: URL_WITH_SECRET, key: "key-value-1" });
    for (const shown of [JSON.stringify(config), inspect(config, { depth: 5 }), String(config.wake.target)]) {
      expect(shown).not.toContain("secret-path");
      expect(shown).not.toContain("key-value-1");
    }
  });

  it("says which half is missing or wrong, without quoting it", () => {
    expect(readWakeConfig({ GROK_WEBHOOK_URL: URL_WITH_SECRET }).offReason).toBe(
      "GROK_WEBHOOK_URL is set but GROK_WEBHOOK_KEY is empty.",
    );
    expect(readWakeConfig({ GROK_WEBHOOK_KEY: "k" }).offReason).toBe(
      "GROK_WEBHOOK_KEY is set but GROK_WEBHOOK_URL is empty.",
    );
    const bad = readWakeConfig({ GROK_WEBHOOK_URL: "secret-path no scheme", GROK_WEBHOOK_KEY: "k" });
    expect(bad).toMatchObject({ target: null, offReason: "GROK_WEBHOOK_URL is not an http or https URL." });
  });

  it("reads the cap and the price check interval, and refuses nonsense", () => {
    expect(readWakeConfig({ GROK_WAKE_DAILY_CAP: "0", GROK_WAKE_PRICE_CHECK_MS: "60000" })).toMatchObject({
      dailyCap: 0,
      priceCheckMs: 60_000,
    });
    expect(() => readWakeConfig({ GROK_WAKE_DAILY_CAP: "-1" })).toThrow(/GROK_WAKE_DAILY_CAP/);
    expect(() => readWakeConfig({ GROK_WAKE_PRICE_CHECK_MS: "10" })).toThrow(/GROK_WAKE_PRICE_CHECK_MS/);
  });

  it("runs on the test clock only when asked, and never in production", () => {
    expect(readWakeConfig({ GROK_WAKE_TEST_CLOCK: "on" }).testClock).toBe(true);
    expect(readWakeConfig({ GROK_WAKE_TEST_CLOCK: "off" }).testClock).toBe(false);
    expect(() => readWakeConfig({ GROK_WAKE_TEST_CLOCK: "yes" })).toThrow(/GROK_WAKE_TEST_CLOCK/);
    expect(
      readConsoleConfig({ CONSOLE_MODE: "development", GROK_WAKE_TEST_CLOCK: "on" }).wake.testClock,
    ).toBe(true);
    expect(() =>
      readConsoleConfig({
        CONSOLE_MODE: "production",
        GROK_WAKE_TEST_CLOCK: "on",
        CONSOLE_URL: "https://console.example",
      }),
    ).toThrow(/GROK_WAKE_TEST_CLOCK=on is refused in production/);
    expect(() => readConsoleConfig({ NODE_ENV: "production", GROK_WAKE_TEST_CLOCK: "on" })).toThrow(
      /refused in production/,
    );
  });
});

describe("the MCP server's addresses", () => {
  const dev = { CONSOLE_MODE: "development" };
  it("asks the MCP server on this machine, where it listens, only while MCP_PUBLIC_URL is not set", () => {
    expect(readConsoleConfig(dev)).toMatchObject({
      mcpPublicUrl: null,
      mcpLocalUrl: "http://127.0.0.1:8787",
    });
    expect(readConsoleConfig({ ...dev, MCP_PORT: "9000", MCP_HOST: "0.0.0.0" }).mcpLocalUrl).toBe(
      "http://127.0.0.1:9000",
    );
    expect(readConsoleConfig({ ...dev, MCP_PORT: "nope" }).mcpLocalUrl).toBeNull();
    expect(readConsoleConfig({ ...dev, MCP_PUBLIC_URL: "https://mcp.example.dev/mcp" })).toMatchObject({
      mcpPublicUrl: "https://mcp.example.dev/mcp",
      mcpLocalUrl: null,
    });
  });
});
