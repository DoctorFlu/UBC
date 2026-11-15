import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import { Secret } from "../src/secret";
import { TEST_PRIVATE_KEY, testConfig } from "./helpers";

const VALUE = "super-secret-value-0123456789abcdef";

describe("Secret", () => {
  const secret = new Secret(VALUE);

  it("reveals the value only through reveal()", () => {
    expect(secret.reveal()).toBe(VALUE);
  });

  it.each([
    ["String()", () => String(secret)],
    ["toString()", () => secret.toString()],
    ["a template literal", () => `value=${secret as unknown as string}`],
    ["string concatenation", () => "x" + (secret as unknown as string)],
    ["JSON.stringify", () => JSON.stringify(secret)],
    ["JSON.stringify of a containing object", () => JSON.stringify({ nested: { secret } })],
    ["util.inspect", () => inspect(secret)],
    ["util.inspect with showHidden", () => inspect({ secret }, { showHidden: true, depth: 10 })],
    ["Object.entries", () => JSON.stringify(Object.entries(secret))],
  ])("does not leak through %s", (_how, render) => {
    expect(render()).not.toContain(VALUE);
  });

  it("does not leak through a structured logger line", () => {
    const lines: string[] = [];
    createLogger({ sink: (line) => lines.push(line) }).info("test", { value: secret });
    expect(lines.join("")).not.toContain(VALUE);
    expect(lines.join("")).toContain("[redacted]");
  });

  it("keeps every secret in the parsed config redacted when the config is serialized", () => {
    const config = testConfig({
      AGENT_PRIVATE_KEY: TEST_PRIVATE_KEY,
      ARC_RPC_URL: "https://name.arc-testnet.example.pro/apikey123456/",
      CONSOLE_SERVICE_TOKEN: "console-service-token-123",
      CONSOLE_URL: "http://localhost:3000",
    });
    for (const rendered of [
      JSON.stringify(config),
      inspect(config, { depth: 10, showHidden: true }),
      String(config.authToken),
    ]) {
      expect(rendered).not.toContain(config.authToken.reveal());
      expect(rendered).not.toContain(TEST_PRIVATE_KEY.slice(2));
      expect(rendered).not.toContain("apikey123456");
      expect(rendered).not.toContain("console-service-token-123");
    }
  });
});
