/**
 * The console surface: what a signed-in member of one workspace can do to another workspace through the
 * console's own HTTP API. The red team starts the real console code for it (dashboard/scripts/
 * redteam-console.ts: every route module under `src/app/api`, served by plain Node, without Next.js's
 * pages) on a free port and a fresh data folder seeded with two workspaces: Alice claimed the first one
 * (the server's own mandate), and Bob, the attacker, signed up for his own.
 *
 * The two session cookies and the service token are held privately and never printed or returned.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ID_HEADER } from "@mandate/shared";

const DASHBOARD_DIR = fileURLToPath(new URL("../../dashboard/", import.meta.url));
const READY_TIMEOUT_MS = 90_000;
/** The console's own log lines, kept for a failed start; never part of the report. */
const LOG_LINES = 50;

export type Member = "alice" | "bob";

export interface WorkspaceIds {
  workspaceId: string;
  mandateId: string;
  agentId: string;
}

interface Seeded extends WorkspaceIds {
  cookie: string;
}

export interface ApiResponse {
  status: number;
  /** The body, at most 64 KiB of it. */
  text: string;
}

/** Alice's holding, which the console was seeded with: a quantity nobody else has. */
export const ALICE_HOLDING_QUANTITY = "0.4242";

export class ConsoleApi {
  readonly base: string;
  readonly alice: WorkspaceIds;
  readonly bob: WorkspaceIds;
  readonly #cookies: Record<Member, string>;
  readonly #serviceToken: string;
  readonly #child: ChildProcess;

  constructor(base: string, seeded: Record<Member, Seeded>, serviceToken: string, child: ChildProcess) {
    this.base = base;
    const ids = ({ workspaceId, mandateId, agentId }: Seeded): WorkspaceIds => ({
      workspaceId,
      mandateId,
      agentId,
    });
    this.alice = ids(seeded.alice);
    this.bob = ids(seeded.bob);
    this.#cookies = { alice: seeded.alice.cookie, bob: seeded.bob.cookie };
    this.#serviceToken = serviceToken;
    this.#child = child;
  }

  /**
   * A request as a signed-in member, from the console's own pages: the session cookie, and on a write
   * the console's own `Origin`, so the cross-site check passes and what answers is the tenancy check.
   */
  as(member: Member, method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const write = method !== "GET" && method !== "HEAD";
    return this.#send(method, path, body, {
      cookie: this.#cookies[member],
      ...(write ? { origin: this.base } : {}),
    });
  }

  /**
   * A request as the MCP server makes it: the service token, and the agent it is for (none for the token
   * lookup, the one route that names no agent).
   */
  asServer(agentId: string | null, method: string, path: string, body?: unknown): Promise<ApiResponse> {
    return this.#send(method, path, body, {
      authorization: `Bearer ${this.#serviceToken}`,
      ...(agentId === null ? {} : { [AGENT_ID_HEADER]: agentId }),
    });
  }

  /** A request with a bearer of the caller's choosing (an agent token where the service token belongs). */
  withBearer(bearer: string, method: string, path: string, headers: Record<string, string> = {}) {
    return this.#send(method, path, undefined, { authorization: `Bearer ${bearer}`, ...headers });
  }

  /** The first event of a member's live stream, then the stream is closed. */
  async firstEvent(member: Member, path: string): Promise<ApiResponse> {
    const controller = new AbortController();
    const response = await fetch(new URL(path, this.base), {
      headers: { cookie: this.#cookies[member], accept: "text/event-stream" },
      signal: controller.signal,
    });
    let text = "";
    try {
      if (response.body === null) return { status: response.status, text };
      const decoder = new TextDecoder();
      const deadline = Date.now() + 10_000;
      for await (const chunk of response.body) {
        text += decoder.decode(chunk as Uint8Array, { stream: true });
        if (/\n\n/.test(text) && text.includes("data:")) break;
        if (Date.now() > deadline || text.length > 1 << 20) break;
      }
    } finally {
      controller.abort();
    }
    return { status: response.status, text };
  }

  /** Whether a text holds one of the secrets this class keeps. */
  leaks(text: string): boolean {
    return [this.#cookies.alice, this.#cookies.bob, this.#serviceToken].some((secret) => {
      const value = secret.slice(secret.indexOf("=") + 1);
      return value.length > 0 && text.includes(value);
    });
  }

  async #send(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<ApiResponse> {
    const response = await fetch(new URL(path, this.base), {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, text: text.slice(0, 1 << 16) };
  }

  stop(): Promise<void> {
    return stopChild(this.#child);
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** Starts the console API on `port` with a new data folder, and waits until it has seeded both workspaces. */
export async function startConsoleApi(port: number): Promise<ConsoleApi> {
  const base = `http://127.0.0.1:${String(port)}`;
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-redteam-console-"));
  const serviceToken = randomBytes(24).toString("base64url");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  // Only what the console needs: nothing from the developer's shell or .env reaches it.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    CONSOLE_MODE: "development",
    CONSOLE_URL: base,
    CONSOLE_DATA_DIR: join(dataDir, "console"),
    CONSOLE_SERVICE_TOKEN: serviceToken,
    CONSOLE_EVENT_SOURCE: "rpc",
    // No chain and no Gemini: the attacks are about who may read and write what, not about the chain.
    POLICY_DEPLOYMENT_FILE: join(dataDir, "no-deployment.json"),
    POLICY_ADDRESS: "",
    GEMINI_API_URL: "http://127.0.0.1:9",
    GROK_WEBHOOK_URL: "",
    GROK_WEBHOOK_KEY: "",
  };
  const child = spawn(
    process.execPath,
    [tsx, "--import", "./scripts/server-only.mjs", "scripts/redteam-console.ts"],
    { cwd: DASHBOARD_DIR, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    log.push(...chunk.split("\n").filter((line) => line.trim() !== ""));
    log.splice(0, Math.max(0, log.length - LOG_LINES));
  });

  try {
    const seeded = await new Promise<Record<Member, Seeded>>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        reject(new Error(`the console API did not start in ${String(READY_TIMEOUT_MS / 1000)} s`));
      }, READY_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const line = out.split("\n").find((candidate) => candidate.startsWith('{"ready":true'));
        if (line === undefined) return;
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<Member, Seeded>);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `the console API stopped (${signal ?? `code ${String(code)}`}): ${log.slice(-5).join(" | ")}`,
          ),
        );
      });
    });
    return new ConsoleApi(base, seeded, serviceToken, child);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
