/**
 * `npm run mcp:smoke [-- <server-url>]`: connects to a running MCP server with the official SDK
 * client, the same way Grok Bot does, and exercises it end to end. The token is read from the .env
 * file, never from the command line, and never printed.
 *
 * The URL defaults to the local server; pass the tunnel URL to test through Cloudflare.
 * Set MCP_ERA=auto to negotiate the 2026-07-28 protocol instead of the 2025 initialize handshake.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadEnvFile, resolveEnvFile } from "../src/env-file";

function fail(message: string): never {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
}

function summaryOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.map((block) => block.text ?? `[${block.type}]`).join(" ");
}

async function main(): Promise<void> {
  loadEnvFile(resolveEnvFile());
  const token = process.env["MCP_AUTH_TOKEN"];
  if (token === undefined || token === "") fail("MCP_AUTH_TOKEN is not set in the .env file");

  const arg = process.argv[2];
  const base = arg ?? `http://127.0.0.1:${process.env["MCP_PORT"] ?? "8787"}`;
  const url = new URL(base.endsWith("/mcp") ? base : `${base.replace(/\/$/, "")}/mcp`);
  process.stdout.write(`Server: ${url.href}\n`);

  const health = await fetch(new URL("/health", url));
  process.stdout.write(`GET /health -> ${health.status} ${await health.text()}\n`);

  const anonymous = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (anonymous.status !== 401) fail(`expected 401 without a token, got ${anonymous.status}`);
  process.stdout.write(
    `POST /mcp without a token -> 401, WWW-Authenticate: ${anonymous.headers.get("www-authenticate") ?? ""}\n`,
  );

  const era = process.env["MCP_ERA"] === "auto" ? "auto" : "legacy";
  const client = new Client(
    { name: "mandate-smoke", version: "0.0.0" },
    era === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  process.stdout.write(
    `Connected: era ${client.getProtocolEra() ?? "?"}, server ${JSON.stringify(client.getServerVersion())}\n`,
  );
  process.stdout.write(`Instructions: ${(client.getInstructions() ?? "").split("\n")[0] ?? ""}\n`);

  const { tools } = await client.listTools();
  process.stdout.write(`Tools: ${tools.map((tool) => tool.name).join(", ")}\n`);

  for (const name of ["ping", "whoami", "get_setup_state"]) {
    const result = await client.callTool({ name, arguments: {} });
    if (result.isError === true) fail(`${name}: ${summaryOf(result)}`);
    process.stdout.write(
      `${name}: ${summaryOf(result)}\n  structured: ${JSON.stringify(result.structuredContent)}\n`,
    );
  }

  try {
    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    process.stdout.write(`no_such_tool: isError=${String(unknown.isError)} ${summaryOf(unknown)}\n`);
  } catch (error) {
    process.stdout.write(`no_such_tool: rejected (${error instanceof Error ? error.message : "error"})\n`);
  }

  await client.close();
  process.stdout.write("OK\n");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
});
