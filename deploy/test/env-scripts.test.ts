/**
 * deploy/init-env.sh, the script that creates the host's generated secrets, run for real with bash against
 * an env file in a temporary folder.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const deployDir = join(import.meta.dirname, "..");
const initEnv = join(deployDir, "init-env.sh");
const template = readFileSync(join(deployDir, "mandate.env.template"), "utf8");

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
if (!hasBash) console.warn("deploy/test/env-scripts.test.ts: skipped, because bash is not installed");

/** The values init-env.sh generates: 32 random bytes each, as unpadded base64url. */
const GENERATED = ["MCP_AUTH_TOKEN", "CONSOLE_SERVICE_TOKEN", "CONSOLE_MASTER_KEY"] as const;

interface Run {
  status: number | null;
  output: string;
}

let dir: string;
let envFile: string;

function run(script: string): Run {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, MANDATE_ENV_FILE: envFile },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const read = () => readFileSync(envFile, "utf8");
const lines = (text: string) => text.split("\n");
const valueOf = (text: string, key: string) =>
  lines(text)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
const without = (text: string, ...keys: string[]) =>
  lines(text).filter((line) => !keys.some((key) => line.startsWith(`${key}=`)));
const mode = () => statSync(envFile).mode & 0o777;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mandate-env-scripts-"));
  envFile = join(dir, "mandate-host.conf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("deploy/init-env.sh", () => {
  it("creates the env file from the template, owner-only, with every generated value filled and not printed", () => {
    const first = run(initEnv);
    expect(first.status).toBe(0);
    expect(mode()).toBe(0o600);
    const text = read();
    const values = GENERATED.map((key) => valueOf(text, key) ?? "");
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.output).not.toContain(value);
    }
    expect(new Set(values).size).toBe(GENERATED.length);
    // The master key is 32 bytes, as the console reads it (64 hex digits, or base64 or base64url).
    expect(Buffer.from(values[2] ?? "", "base64url")).toHaveLength(32);
    // Every other line, the preset COMPOSE_FILE included, is the template's.
    expect(without(text, ...GENERATED)).toEqual(without(template, ...GENERATED));
    expect(valueOf(text, "COMPOSE_FILE")).toBe("compose.yml:compose.demo.yml");
    expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
  });

  it("keeps every generated value byte for byte when run again", () => {
    expect(run(initEnv).status).toBe(0);
    const before = read();
    const again = run(initEnv);
    expect(again.status).toBe(0);
    expect(again.output).toContain("MCP_AUTH_TOKEN is already set; kept it.");
    expect(again.output).toContain("CONSOLE_MASTER_KEY is already set; kept it.");
    expect(read()).toBe(before);
  });

  it("keeps a value that is already set and changes no other line", () => {
    const preset = template
      .replace(/^MCP_AUTH_TOKEN=$/m, "MCP_AUTH_TOKEN=the-owner-chose-this-token-already-0123456789")
      .replace(/^MANDATE_HOST=$/m, "MANDATE_HOST=203-0-113-10.sslip.io");
    writeFileSync(envFile, preset, { mode: 0o644 });
    expect(run(initEnv).status).toBe(0);
    const text = read();
    expect(valueOf(text, "MCP_AUTH_TOKEN")).toBe("the-owner-chose-this-token-already-0123456789");
    expect(valueOf(text, "CONSOLE_SERVICE_TOKEN")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(without(text, "CONSOLE_SERVICE_TOKEN", "CONSOLE_MASTER_KEY")).toEqual(
      without(preset, "CONSOLE_SERVICE_TOKEN", "CONSOLE_MASTER_KEY"),
    );
    expect(mode()).toBe(0o600);
  });

  it("upgrades an env file from before workspaces: adds the master key and leaves every line as it was", () => {
    // An env file the earlier init-env.sh made, with lines the new template no longer has. Test values only.
    const old = [
      "COMPOSE_FILE=compose.yml:compose.arc.yml",
      "MANDATE_HOST=203-0-113-10.sslip.io",
      "MCP_AUTH_TOKEN=an-existing-mcp-token-0123456789abcdefghijk",
      "CONSOLE_SERVICE_TOKEN=an-existing-service-token-0123456789abcdef",
      "CONSOLE_USER=owner",
      "CONSOLE_PASSWORD_HASH=dGVzdC1vbmx5LW5vdC1hLXJlYWwtaGFzaA",
      "GROK_WEBHOOK_URL='https://example.invalid/hook'",
      "",
    ].join("\n");
    writeFileSync(envFile, old, { mode: 0o600 });
    const result = run(initEnv);
    expect(result.status).toBe(0);
    const text = read();
    const key = valueOf(text, "CONSOLE_MASTER_KEY") ?? "";
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.output).not.toContain(key);
    expect(text).toBe(`${old}CONSOLE_MASTER_KEY=${key}\n`);
  });
});
