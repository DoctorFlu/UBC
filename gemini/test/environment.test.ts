import { describe, expect, it } from "vitest";
import { GEMINI_HOSTS, marketDataSource } from "../src/environment";

describe("the stack's market data source", () => {
  it("is production for the simulated venue, whatever GEMINI_ENV says", () => {
    expect(marketDataSource({})).toEqual({
      environment: "production",
      venue: "simulated",
      baseUrl: GEMINI_HOSTS.production,
      settings: "EXECUTOR_VENUE=simulated (the default)",
    });
    // The owner's .env holds GEMINI_ENV=sandbox for the executor; the simulated stack keeps live prices.
    expect(marketDataSource({ GEMINI_ENV: "sandbox" }).environment).toBe("production");
  });

  it("follows the venue's environment when the venue is Gemini: the sandbox by default", () => {
    expect(marketDataSource({ EXECUTOR_VENUE: "gemini" })).toMatchObject({
      environment: "sandbox",
      baseUrl: GEMINI_HOSTS.sandbox,
      settings: "EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox",
    });
    expect(marketDataSource({ EXECUTOR_VENUE: " Gemini ", GEMINI_ENV: "production" })).toMatchObject({
      environment: "production",
      baseUrl: GEMINI_HOSTS.production,
    });
  });

  it("takes GEMINI_API_URL only for the same host or a loopback stand-in", () => {
    const sandbox = { EXECUTOR_VENUE: "gemini", GEMINI_ENV: "sandbox" };
    expect(marketDataSource({ ...sandbox, GEMINI_API_URL: "https://api.sandbox.gemini.com/" }).baseUrl).toBe(
      GEMINI_HOSTS.sandbox,
    );
    expect(marketDataSource({ ...sandbox, GEMINI_API_URL: "http://127.0.0.1:9255" }).baseUrl).toBe(
      "http://127.0.0.1:9255",
    );
    expect(() => marketDataSource({ ...sandbox, GEMINI_API_URL: "https://api.gemini.com" })).toThrow(
      "GEMINI_API_URL is https://api.gemini.com, but EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox means " +
        "Gemini's sandbox (https://api.sandbox.gemini.com). Unset GEMINI_API_URL, or set it to that same host.",
    );
    expect(() => marketDataSource({ GEMINI_API_URL: "https://api.sandbox.gemini.com" })).toThrow(
      /EXECUTOR_VENUE=simulated \(the default\) means Gemini's production/,
    );
  });

  it("refuses settings it does not know", () => {
    expect(() => marketDataSource({ EXECUTOR_VENUE: "kalshi" })).toThrow(/EXECUTOR_VENUE must be/);
    expect(() => marketDataSource({ EXECUTOR_VENUE: "gemini", GEMINI_ENV: "staging" })).toThrow(
      /GEMINI_ENV must be sandbox or production/,
    );
  });
});
