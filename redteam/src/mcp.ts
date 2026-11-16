/**
 * The MCP surface: what a compromised or jailbroken Grok Bot can do. It holds the server's bearer
 * token and calls tools over HTTP with the official MCP SDK client, opening a fresh session for
 * every call as Grok Bot does. It can also send raw HTTP requests, to probe the transport's limits.
 *
 * The token is held privately and never printed or returned.
 */
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type Structured = Record<string, unknown>;

export interface ToolResult {
  /** True when the server answered with an error result (for example `INVALID_INPUT`). */
  isError: boolean;
  /** The error code of an error result (`INVALID_INPUT: ...` gives `INVALID_INPUT`), or a protocol error. */
  errorCode: string | null;
  structured: Structured | undefined;
  /** The summary or error text the model reads. */
  text: string;
}

export interface RawResponse {
  status: number;
  body: string;
}

const field = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );

export { field };

export class McpAttacker {
  readonly endpoint: URL;
  readonly #token: string;

  constructor(base: string, token: string) {
    this.endpoint = new URL("/mcp", base);
    this.#token = token;
  }

  /** One tool call in a fresh MCP session. Protocol errors (an unknown tool) come back as results too. */
  async call(name: string, args: Structured = {}): Promise<ToolResult> {
    const client = new Client({ name: "mandate-redteam", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(this.endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${this.#token}` } },
      }),
    );
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Structured;
        content?: { type: string; text?: string }[];
      };
      const text = (result.content ?? []).map((block) => block.text ?? "").join(" ");
      const isError = result.isError === true;
      const code = isError ? (/^([A-Z_]+):/.exec(text)?.[1] ?? "ERROR") : null;
      return { isError, errorCode: code, structured: result.structuredContent, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, errorCode: "PROTOCOL_ERROR", structured: undefined, text: message };
    } finally {
      await client.close();
    }
  }

  /**
   * A raw POST to `/mcp` on its own connection, closed afterwards, so a probe the server cuts short
   * (an oversized body) never leaves a broken socket in the pool the SDK client reuses.
   *
   * `auth` picks the Authorization header: the real token, none, or a given string (for wrong-token
   * attempts). A string body is sent with Content-Length; chunks are sent with chunked encoding.
   */
  post(options: {
    body: string | Uint8Array[];
    auth: "token" | "none" | { header: string };
    headers?: Record<string, string>;
    query?: Record<string, string>;
  }): Promise<RawResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      connection: "close",
      ...options.headers,
    };
    if (options.auth === "token") headers.authorization = `Bearer ${this.#token}`;
    else if (options.auth !== "none") headers.authorization = options.auth.header;
    if (typeof options.body === "string") headers["content-length"] = String(Buffer.byteLength(options.body));
    const url = new URL(this.endpoint);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 500) body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: body.slice(0, 500) });
        });
        res.on("error", reject);
      });
      // The server may answer (413) and close before the whole body is written; that is the point.
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ECONNRESET") reject(error);
      });
      if (typeof options.body === "string") {
        req.end(options.body);
      } else {
        for (const chunk of options.body) req.write(chunk);
        req.end();
      }
    });
  }

  /** A wrong token of the same length as the real one, never derived from it. */
  wrongTokenLike(): string {
    return "x".repeat(this.#token.length);
  }

  /** The real token minus its last character: a near miss, used only inside the request. */
  truncatedTokenHeader(): string {
    return `Bearer ${this.#token.slice(0, -1)}`;
  }

  /** The token in a query string instead of the header. The URL is never printed. */
  postWithTokenInQuery(body: string): Promise<RawResponse> {
    return this.post({ body, auth: "none", query: { access_token: this.#token } });
  }

  /** Whether some text contains the token, so a check can prove it never leaks into an answer. */
  leaks(text: string): boolean {
    return text.includes(this.#token);
  }
}
