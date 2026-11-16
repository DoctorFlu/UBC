/**
 * The two scripts that create the host's secrets (deploy/init-env.sh and deploy/set-console-password.sh),
 * run for real with bash against an env file in a temporary folder. Hashing goes through
 * MANDATE_HASH_COMMAND, so these tests need no Docker; docs/hosting.md and the PR record the run with the
 * pinned Caddy image.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const deployDir = join(import.meta.dirname, "..");
const initEnv = join(deployDir, "init-env.sh");
const setPassword = join(deployDir, "set-console-password.sh");
const template = readFileSync(join(deployDir, "mandate.env.template"), "utf8");

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
if (!hasBash) console.warn("deploy/test/env-scripts.test.ts: skipped, because bash is not installed");

/** Hashes nothing: records what it was given and prints FAKE_HASH, as `caddy hash-password` prints a hash. */
const FAKE_HASH_COMMAND = 'cat > "$CAPTURE"; printf "%s\\n" "$FAKE_HASH"';
const HASH_ONE = "$2a$14$abcdefghijklmnopqrstuuJ0FakeHashNumberOne.abcdefghijklmn";
const HASH_TWO = "$2a$14$zyxwvutsrqponmlkjihgfeK1FakeHashNumberTwo.zyxwvutsrqpon";
// Spaces at both ends, a backslash and a "$": each is kept exactly and never shell-expanded.
const PASSWORD = String.raw`  correct horse \ battery $HOME staple `;

interface Run {
  status: number | null;
  output: string;
}

let dir: string;
let envFile: string;
let capture: string;

function run(script: string, input = "", env: Record<string, string> = {}): Run {
  const result = spawnSync("bash", [script], {
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      MANDATE_ENV_FILE: envFile,
      MANDATE_HASH_COMMAND: FAKE_HASH_COMMAND,
      CAPTURE: capture,
      FAKE_HASH: HASH_ONE,
      ...env,
    },
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
const decoded = (text: string) =>
  Buffer.from(valueOf(text, "CONSOLE_PASSWORD_HASH") ?? "", "base64").toString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mandate-env-scripts-"));
  envFile = join(dir, "mandate-host.conf");
  capture = join(dir, "hash-input");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("deploy/init-env.sh", () => {
  it("creates the env file from the template, owner-only, with both tokens filled and not printed", () => {
    const first = run(initEnv);
    expect(first.status).toBe(0);
    expect(mode()).toBe(0o600);
    const text = read();
    const mcp = valueOf(text, "MCP_AUTH_TOKEN") ?? "";
    const service = valueOf(text, "CONSOLE_SERVICE_TOKEN") ?? "";
    expect(mcp).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mcp).not.toBe(service);
    expect(first.output).not.toContain(mcp);
    expect(first.output).not.toContain(service);
    // Every other line, the preset COMPOSE_FILE included, is the template's.
    expect(without(text, "MCP_AUTH_TOKEN", "CONSOLE_SERVICE_TOKEN")).toEqual(
      without(template, "MCP_AUTH_TOKEN", "CONSOLE_SERVICE_TOKEN"),
    );
    expect(valueOf(text, "COMPOSE_FILE")).toBe("compose.yml:compose.demo.yml");
    expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
  });

  it("keeps both tokens byte for byte when run again", () => {
    expect(run(initEnv).status).toBe(0);
    const before = read();
    const again = run(initEnv);
    expect(again.status).toBe(0);
    expect(again.output).toContain("MCP_AUTH_TOKEN is already set; kept it.");
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
    expect(without(text, "CONSOLE_SERVICE_TOKEN")).toEqual(without(preset, "CONSOLE_SERVICE_TOKEN"));
    expect(mode()).toBe(0o600);
  });
});

describe.skipIf(!hasBash)("deploy/set-console-password.sh", () => {
  beforeEach(() => {
    expect(run(initEnv).status).toBe(0);
  });

  it("refuses two different passwords and leaves the file as it was", () => {
    const before = read();
    const other = "another password of enough length";
    const result = run(setPassword, `${PASSWORD}\n${other}\n`);
    expect(result.status).toBe(1);
    expect(result.output).toContain("The two passwords differ; nothing changed.");
    expect(read()).toBe(before);
    expect(result.output).not.toContain(PASSWORD.trim());
    expect(result.output).not.toContain(other);
  });

  it("refuses a password under 16 characters and leaves the file as it was", () => {
    const before = read();
    const result = run(setPassword, "fifteen-chars!!\nfifteen-chars!!\n");
    expect(result.status).toBe(1);
    expect(result.output).toContain("Use at least 16 characters; nothing changed.");
    expect(read()).toBe(before);
    expect(result.output).not.toContain("fifteen-chars!!");
  });

  it("stores only the hash, exactly as hashed, and never the password", () => {
    const before = read();
    const result = run(setPassword, `${PASSWORD}\n${PASSWORD}\n`);
    expect(result.status).toBe(0);
    const text = read();
    expect(decoded(text)).toBe(HASH_ONE);
    expect(valueOf(text, "CONSOLE_PASSWORD_HASH")).not.toContain("$");
    // The hash command was given exactly the password, spaces and backslash included, on one line.
    expect(readFileSync(capture, "utf8")).toBe(`${PASSWORD}\n`);
    expect(text).not.toContain(PASSWORD.trim());
    expect(result.output).not.toContain(PASSWORD.trim());
    expect(without(text, "CONSOLE_PASSWORD_HASH")).toEqual(without(before, "CONSOLE_PASSWORD_HASH"));
    expect(mode()).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["hash-input", "mandate-host.conf"]);
  });

  it("replaces the hash on a second run, keeping one hash line and every other line", () => {
    expect(run(setPassword, `${PASSWORD}\n${PASSWORD}\n`).status).toBe(0);
    const before = read();
    const changed = "a completely different passphrase";
    expect(run(setPassword, `${changed}\n${changed}\n`, { FAKE_HASH: HASH_TWO }).status).toBe(0);
    const text = read();
    expect(decoded(text)).toBe(HASH_TWO);
    expect(lines(text).filter((line) => line.startsWith("CONSOLE_PASSWORD_HASH="))).toHaveLength(1);
    expect(without(text, "CONSOLE_PASSWORD_HASH")).toEqual(without(before, "CONSOLE_PASSWORD_HASH"));
    expect(text).not.toContain(changed);
  });

  it("refuses to store anything that is not a bcrypt hash", () => {
    const before = read();
    const result = run(setPassword, `${PASSWORD}\n${PASSWORD}\n`, { FAKE_HASH: "Error: no hash today" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("did not return a bcrypt hash; nothing changed.");
    expect(read()).toBe(before);
  });

  it("asks for init-env.sh first when the env file does not exist", () => {
    rmSync(envFile);
    const result = run(setPassword, `${PASSWORD}\n${PASSWORD}\n`);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Run deploy/init-env.sh first.");
  });
});
