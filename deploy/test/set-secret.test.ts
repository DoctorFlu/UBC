/**
 * deploy/set-secret.sh, run for real with bash against an env file in a temporary folder: the value comes in on
 * standard input, as `pbpaste | ... set-secret.sh NAME` sends it. The prompt for a terminal is not covered here;
 * docs/hosting.md and the PR record a run of it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const deployDir = join(import.meta.dirname, "..");
const setSecret = join(deployDir, "set-secret.sh");
const template = readFileSync(join(deployDir, "mandate.env.template"), "utf8");

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
if (!hasBash) console.warn("deploy/test/set-secret.test.ts: skipped, because bash is not installed");

// A URL with what a shell or docker compose would misread: "$", " #" is not allowed (a space), but "#", "&",
// "=", "%", a backslash and a double quote are, and each is stored exactly.
const URL = String.raw`https://hooks.example.test/v1/routines/abc$HOME/run?sig=a%2Fb&x=1#frag\"end`;
const KEY = "gk_live_0123456789abcdefABCDEF-_.~+/=";

interface Run {
  status: number | null;
  output: string;
}

let dir: string;
let envFile: string;

function run(args: string[], input: string | Buffer = "", env: Record<string, string> = {}): Run {
  const result = spawnSync("bash", [setSecret, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, MANDATE_ENV_FILE: envFile, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const read = () => readFileSync(envFile, "utf8");
const lines = (text: string) => text.split("\n");
const without = (text: string, key: string) => lines(text).filter((line) => !line.startsWith(`${key}=`));
const mode = () => statSync(envFile).mode & 0o777;
const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** What docker compose and POSIX shells read from NAME='value': the text between the quotes. */
const storedValue = (text: string, key: string) => {
  const line = lines(text).find((l) => l.startsWith(`${key}=`));
  const match = line === undefined ? null : /^[A-Z_]+='([^']*)'$/.exec(line);
  return match?.[1];
};

/** A refusal changes nothing, leaves only the env file in the folder and never shows the value. */
function expectRefused(result: Run, message: string, before: string, value: string) {
  expect(result.status).toBe(1);
  expect(result.output).toContain(message);
  expect(result.output).toContain("Nothing changed.");
  expect(read()).toBe(before);
  expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
  if (value.trim().length >= 4) expect(result.output).not.toContain(value.trim());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mandate-set-secret-"));
  envFile = join(dir, "mandate-host.conf");
  writeFileSync(envFile, template, { mode: 0o600 });
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("deploy/set-secret.sh", () => {
  it("sets an empty line from standard input, dropping one trailing newline, and prints only length and hash", () => {
    const before = read();
    const result = run(["GROK_WEBHOOK_URL"], `${URL}\n`);
    expect(result.status).toBe(0);
    const text = read();
    expect(storedValue(text, "GROK_WEBHOOK_URL")).toBe(URL);
    expect(without(text, "GROK_WEBHOOK_URL")).toEqual(without(before, "GROK_WEBHOOK_URL"));
    expect(result.output).toBe(
      `GROK_WEBHOOK_URL set in ${envFile}: ${URL.length} characters, sha256 ${short(URL)}.\n`,
    );
    expect(result.output).not.toContain("hooks.example");
    expect(mode()).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
  });

  it("takes a value without a trailing newline as it is", () => {
    expect(run(["GROK_WEBHOOK_KEY"], KEY).status).toBe(0);
    expect(storedValue(read(), "GROK_WEBHOOK_KEY")).toBe(KEY);
  });

  it("replaces a value that is set, keeping one line for the name and every other line", () => {
    expect(run(["GROK_WEBHOOK_KEY"], `${KEY}\n`).status).toBe(0);
    const before = read();
    expect(run(["GROK_WEBHOOK_KEY"], "a-second-key-value\n").status).toBe(0);
    const text = read();
    expect(storedValue(text, "GROK_WEBHOOK_KEY")).toBe("a-second-key-value");
    expect(lines(text).filter((line) => line.startsWith("GROK_WEBHOOK_KEY="))).toHaveLength(1);
    expect(without(text, "GROK_WEBHOOK_KEY")).toEqual(without(before, "GROK_WEBHOOK_KEY"));
    expect(text).not.toContain(KEY);
  });

  it("appends a name the file does not have, after a last line without a newline", () => {
    writeFileSync(envFile, "FIRST=1\nLAST=2", { mode: 0o600 });
    expect(run(["GEMINI_API_KEY"], "sandbox-key-1\n").status).toBe(0);
    expect(read()).toBe("FIRST=1\nLAST=2\nGEMINI_API_KEY='sandbox-key-1'\n");
  });

  it("keeps a file without a final newline byte for byte apart from the one line", () => {
    writeFileSync(envFile, "A=1\nGEMINI_API_SECRET=\nB=  spaced value # comment", { mode: 0o600 });
    expect(run(["GEMINI_API_SECRET"], "s3cr3t\n").status).toBe(0);
    expect(read()).toBe("A=1\nGEMINI_API_SECRET='s3cr3t'\nB=  spaced value # comment");
  });

  it.each([
    ["CONSOLE_PASSWORD_HASH"],
    ["MCP_AUTH_TOKEN"],
    ["X402_BUYER_PRIVATE_KEY"],
    ["grok_webhook_url"],
    ["GROK_WEBHOOK"],
    [""],
  ])("refuses the name %j and changes nothing", (name) => {
    const before = read();
    const result = run([name], "some-value-here\n");
    expect(result.status).toBe(2);
    expect(result.output).toContain(
      "NAME is one of: GROK_WEBHOOK_URL GROK_WEBHOOK_KEY GEMINI_API_KEY GEMINI_API_SECRET AGENT_PRIVATE_KEY EXECUTOR_PRIVATE_KEY",
    );
    expect(read()).toBe(before);
  });

  it("refuses no name and two names", () => {
    expect(run([], "v\n").status).toBe(2);
    expect(run(["GROK_WEBHOOK_KEY", "GROK_WEBHOOK_URL"], "v\n").status).toBe(2);
  });

  it("never echoes an argument that is not a name, in case a value was pasted there", () => {
    const before = read();
    const pasted = "https://hooks.example.test/pasted-by-mistake";
    const result = run([pasted], "");
    expect(result.status).toBe(2);
    expect(result.output).toContain("That name cannot be set with this script.");
    expect(result.output).not.toContain("pasted-by-mistake");
    expect(read()).toBe(before);
  });

  it.each([
    ["", "the value is empty."],
    ["\n", "the value is empty."],
    ["two-line\nvalue\n", "control character"],
    ["one-extra-newline\n\n", "control character"],
    ["carriage-return-value\r\n", "control character"],
    ["tab\tinside-value", "control character"],
    ["escape\u001b[31m-value", "control character"],
    ["delete\u007f-value", "control character"],
    ["non-breaking space-value", "outside printable ASCII"],
    [" leading-space-value", "starts or ends with a space"],
    ["trailing-space-value \n", "starts or ends with a space"],
    ["has'single-quote", "single quote"],
  ])("refuses the value %j", (value, message) => {
    const before = read();
    expectRefused(run(["GROK_WEBHOOK_KEY"], value), message, before, value);
  });

  it("refuses a NUL byte instead of dropping it", () => {
    const before = read();
    const result = run(["GROK_WEBHOOK_KEY"], Buffer.from("before-nul\u0000after-nul\n", "utf8"));
    expectRefused(result, "contains a NUL byte", before, "before-nul");
    expect(result.output).not.toContain("after-nul");
  });

  it("refuses a value longer than 8192 bytes", () => {
    const before = read();
    expect(run(["GROK_WEBHOOK_KEY"], `${"k".repeat(8192)}\n`).status).toBe(0);
    const set = read();
    expectRefused(run(["GROK_WEBHOOK_KEY"], `${"k".repeat(8193)}\n`), "longer than 8192 bytes", set, "");
    expect(set).not.toBe(before);
  });

  it.each([
    ["http://hooks.example.test/run", "must start with https://"],
    ["hooks.example.test/run", "must start with https://"],
    ["https://", "must start with https://"],
    ["https://hooks.example.test/a b", "contains a space"],
  ])("refuses the URL %j", (value, message) => {
    const before = read();
    // "https://" alone is the message's own wording, so only longer values are checked for in the output.
    expectRefused(
      run(["GROK_WEBHOOK_URL"], `${value}\n`),
      message,
      before,
      value === "https://" ? "" : value,
    );
  });

  it("takes an Arc key from standard input, as arc:keygen wrote it, and prints only length and hash", () => {
    const key = `0x${"ab".repeat(32)}`;
    writeFileSync(envFile, "AGENT_PRIVATE_KEY=\nEXECUTOR_PRIVATE_KEY=\n", { mode: 0o600 });
    const result = run(["EXECUTOR_PRIVATE_KEY"], `${key}\n`);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("ab".repeat(8));
    expect(read()).toBe(`AGENT_PRIVATE_KEY=\nEXECUTOR_PRIVATE_KEY='${key}'\n`);
  });

  it.each([
    ["ab".repeat(32)],
    [`0x${"ab".repeat(31)}`],
    [`0x${"ab".repeat(33)}`],
    [`0x${"g".repeat(64)}`],
    [`1x${"ab".repeat(32)}`],
  ])("refuses an Arc key %j that is not 0x and 64 hex digits", (value) => {
    writeFileSync(envFile, "AGENT_PRIVATE_KEY=\n", { mode: 0o600 });
    const before = read();
    expectRefused(run(["AGENT_PRIVATE_KEY"], `${value}\n`), "0x and 64 hex digits", before, value);
  });

  it("refuses a file with the name twice", () => {
    writeFileSync(envFile, "GROK_WEBHOOK_KEY=\nX=1\nGROK_WEBHOOK_KEY=\n", { mode: 0o600 });
    const before = read();
    expectRefused(
      run(["GROK_WEBHOOK_KEY"], "secret-value-1\n"),
      "has 2 lines for GROK_WEBHOOK_KEY",
      before,
      "secret-value-1",
    );
  });

  it("refuses a missing env file and a symlink", () => {
    rmSync(envFile);
    const missing = run(["GROK_WEBHOOK_KEY"], "secret-value-1\n");
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("Run deploy/init-env.sh first");
    expect(readdirSync(dir)).toEqual([]);

    const target = join(dir, "real.conf");
    writeFileSync(target, "GROK_WEBHOOK_KEY=\n", { mode: 0o600 });
    symlinkSync(target, envFile);
    const linked = run(["GROK_WEBHOOK_KEY"], "secret-value-1\n");
    expect(linked.status).toBe(1);
    expect(linked.output).toContain("a symlink is not followed");
    expect(readFileSync(target, "utf8")).toBe("GROK_WEBHOOK_KEY=\n");
    expect(readdirSync(dir).sort()).toEqual(["mandate-host.conf", "real.conf"]);
  });

  it.skipIf(process.getuid?.() === 0)("leaves no temporary file when writing fails", () => {
    // The folder is read-only, so the temporary file cannot be created.
    const before = read();
    chmodSync(dir, 0o500);
    const noTemp = run(["GROK_WEBHOOK_KEY"], "secret-value-1\n");
    chmodSync(dir, 0o700);
    expect(noTemp.status).not.toBe(0);
    expect(read()).toBe(before);
    expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
    expect(noTemp.output).not.toContain("secret-value-1");

    // The env file cannot be read, so rebuilding it fails after the temporary file exists.
    chmodSync(envFile, 0o200);
    const unreadable = run(["GROK_WEBHOOK_KEY"], "secret-value-1\n");
    chmodSync(envFile, 0o600);
    expect(unreadable.status).not.toBe(0);
    expect(read()).toBe(before);
    expect(readdirSync(dir)).toEqual(["mandate-host.conf"]);
  });
});
