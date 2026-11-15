import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEnvFile, upsertEnvVar, writeEnvVar } from "../src/env-file";
import { generateToken, rotateToken } from "../scripts/mcp-token";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "mandate-env-"));

describe("upsertEnvVar", () => {
  it("replaces only the target variable and keeps every other byte", () => {
    const before =
      "# comment\nARC_RPC_URL=https://rpc\n\nMCP_AUTH_TOKEN=old\r\nMCP_PORT=8787\nexport OTHER=1";
    expect(upsertEnvVar(before, "MCP_AUTH_TOKEN", "new")).toBe(
      "# comment\nARC_RPC_URL=https://rpc\n\nMCP_AUTH_TOKEN=new\r\nMCP_PORT=8787\nexport OTHER=1",
    );
  });

  it("keeps an export prefix and replaces duplicates", () => {
    expect(upsertEnvVar("export MCP_AUTH_TOKEN = a\nMCP_AUTH_TOKEN=b\n", "MCP_AUTH_TOKEN", "c")).toBe(
      "export MCP_AUTH_TOKEN=c\nMCP_AUTH_TOKEN=c\n",
    );
  });

  it("does not touch variables that merely share a prefix or are commented out", () => {
    const before = "MCP_AUTH_TOKEN_OLD=x\n# MCP_AUTH_TOKEN=y\n";
    expect(upsertEnvVar(before, "MCP_AUTH_TOKEN", "z")).toBe(`${before}MCP_AUTH_TOKEN=z\n`);
  });

  it("appends to files with and without a trailing newline", () => {
    expect(upsertEnvVar("", "K", "v")).toBe("K=v\n");
    expect(upsertEnvVar("A=1", "K", "v")).toBe("A=1\nK=v\n");
  });
});

describe("writeEnvVar and the token script", () => {
  it("creates the file with mode 600", () => {
    const file = path.join(tempDir(), ".env");
    writeEnvVar(file, "MCP_AUTH_TOKEN", "value");
    expect(readFileSync(file, "utf8")).toBe("MCP_AUTH_TOKEN=value\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates the token in place, preserving the other lines and tightening the mode", () => {
    const file = path.join(tempDir(), ".env");
    const other = "# keep me\nAGENT_PRIVATE_KEY=0xabc\n\nMCP_AUTH_TOKEN=old-token\nMCP_PORT=9000\n";
    writeFileSync(file, other, { mode: 0o644 });

    rotateToken(file);
    const first = readFileSync(file, "utf8");
    rotateToken(file);
    const second = readFileSync(file, "utf8");

    const tokenOf = (content: string) => /^MCP_AUTH_TOKEN=(.+)$/m.exec(content)?.[1];
    expect(tokenOf(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(second)).not.toBe(tokenOf(first));
    expect(second.replace(/^MCP_AUTH_TOKEN=.*$/m, "MCP_AUTH_TOKEN=old-token")).toBe(other);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("generates long, distinct tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });
});

describe("resolveEnvFile", () => {
  it("defaults to the repo root .env", () => {
    expect(resolveEnvFile({})).toBe(path.resolve(import.meta.dirname, "../../.env"));
  });

  it("resolves a relative ENV_FILE against the directory npm was started from", () => {
    expect(resolveEnvFile({ ENV_FILE: "local.env", INIT_CWD: "/tmp/somewhere" })).toBe(
      "/tmp/somewhere/local.env",
    );
    expect(resolveEnvFile({ ENV_FILE: "/abs/.env" })).toBe("/abs/.env");
  });
});
