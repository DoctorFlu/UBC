/**
 * The real MCP server (`agent/src/main.ts`) beside a live suite's console and chain, so a test can ask a
 * tool what Grok Bot would read about what the page shows. It runs as a child process with only this run's
 * variables, from an env file (mode 600) that is removed once the server has read it; every key in it is a
 * public anvil key or a token made for this run. `.env` is never read.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devPrivateKey } from "@mandate/devchain";

import { DASHBOARD_DIR } from "./chain";

const AGENT_DIR = join(DASHBOARD_DIR, "..", "agent");
/** Inherited variables win over the env file, so none the server reads is passed on. */
const SERVER_PREFIXES = [
  "MCP_",
  "ARC_",
  "POLICY_",
  "AGENT_",
  "CONSOLE_",
  "SIGNALS_",
  "GEMINI_",
  "X402_",
  "PAYMENTS_",
];
/** The 2025 handshake, which the server answers with plain JSON (`agent/src/mcp/server.ts`). */
const PROTOCOL_VERSION = "2025-06-18";

export interface McpServer {
  base: string;
  /** What the server printed, for a failing test's attachments. */
  logs: string[];
  /** Calls one tool in a fresh exchange, as Grok Bot does, and returns its text and structured result. */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; structured: Record<string, unknown> }>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function startMcpServer(options: {
  rpcUrl: string;
  policy: string;
  consoleUrl: string;
  consoleServiceToken: string;
  geminiUrl: string;
}): Promise<McpServer> {
  const token = randomBytes(32).toString("base64url");
  const port = await freePort();
  const env: Record<string, string> = {
    MCP_AUTH_TOKEN: token,
    MCP_PORT: String(port),
    MCP_HOST: "127.0.0.1",
    MCP_LOG_LEVEL: "info",
    ARC_RPC_URL: options.rpcUrl,
    POLICY_ADDRESS: options.policy,
    POLICY_DEPLOY_BLOCK: "0",
    AGENT_PRIVATE_KEY: devPrivateKey("agent"),
    CONSOLE_URL: options.consoleUrl,
    CONSOLE_SERVICE_TOKEN: options.consoleServiceToken,
    GEMINI_API_URL: options.geminiUrl,
  };
  const dir = mkdtempSync(join(tmpdir(), "mandate-live-mcp-"));
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: envFile };
  for (const key of Object.keys(childEnv)) {
    if (SERVER_PREFIXES.some((prefix) => key.startsWith(prefix))) Reflect.deleteProperty(childEnv, key);
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: AGENT_DIR,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const collect = (chunk: Buffer) => {
    logs.push(
      ...chunk
        .toString()
        .split("\n")
        .filter((line) => line !== ""),
    );
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    let up = false;
    // Waits on the server's own answer, never on a clock alone; a server that exits says so at once.
    while (!up) {
      if (child.exitCode !== null) throw new Error(`the MCP server exited:\n${logs.slice(-20).join("\n")}`);
      up = await fetch(`${base}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (!up) await sleep(200);
    }
  } catch (error) {
    await stopChild(child);
    throw error;
  } finally {
    unlinkSync(envFile);
    rmdirSync(dir);
  }

  let nextId = 1;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (!response.ok || body.error) {
      throw new Error(`${method} answered ${String(response.status)}: ${body.error?.message ?? "no result"}`);
    }
    return body.result as Record<string, unknown>;
  };

  return {
    base,
    logs,
    async call(name, args = {}) {
      await rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mandate-live-e2e", version: "0.0.0" },
      });
      const result = await rpc("tools/call", { name, arguments: args });
      const content = (result["content"] ?? []) as { text?: string }[];
      return {
        text: content.map((block) => block.text ?? "").join(" "),
        structured: (result["structuredContent"] ?? {}) as Record<string, unknown>,
      };
    },
    stop: () => stopChild(child),
  };
}
