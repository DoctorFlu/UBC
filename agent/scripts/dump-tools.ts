/**
 * Prints what `tools/list` returns, tool by tool: sizes and the JSON Schema keywords each tool uses.
 * Used to find out why a client lists fewer tools than the server registers. Never prints the token.
 *
 *   npm run mcp:tools -w @mandate/agent [-- <base url>]
 */
import { loadEnvFile, resolveEnvFile } from "../src/env-file";

function keywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) keywords(item, found);
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key !== "properties") found.add(key);
      if (key === "properties" && value !== null && typeof value === "object") {
        for (const property of Object.values(value)) keywords(property, found);
      } else {
        keywords(value, found);
      }
    }
  }
  return found;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function main(): Promise<void> {
  loadEnvFile(resolveEnvFile());
  const token = process.env["MCP_AUTH_TOKEN"];
  if (token === undefined || token === "") throw new Error("MCP_AUTH_TOKEN is not set in the .env file");
  const base = process.argv[2] ?? `http://127.0.0.1:${process.env["MCP_PORT"] ?? "8787"}`;
  const url = new URL(base.endsWith("/mcp") ? base : `${base.replace(/\/$/, "")}/mcp`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": process.env["MCP_PROTOCOL_VERSION"] ?? "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await response.text();
  process.stdout.write(`HTTP ${response.status}, ${text.length} bytes\n`);
  const body = JSON.parse(text) as {
    result?: { tools?: Record<string, unknown>[]; nextCursor?: string };
    error?: unknown;
  };
  if (body.result?.tools === undefined) {
    process.stdout.write(`${JSON.stringify(body.error ?? body).slice(0, 600)}\n`);
    return;
  }
  process.stdout.write(`nextCursor: ${body.result.nextCursor ?? "none"}\n`);
  for (const tool of body.result.tools) {
    const input = JSON.stringify(tool["inputSchema"] ?? null);
    const output = JSON.stringify(tool["outputSchema"] ?? null);
    process.stdout.write(
      [
        asText(tool["name"]).padEnd(22),
        `desc ${asText(tool["description"]).length}`.padEnd(10),
        `in ${input.length}`.padEnd(9),
        `out ${output.length}`.padEnd(10),
        `keys ${Object.keys(tool).join(",")}`,
        `\n    input keywords: ${[...keywords(tool["inputSchema"])].sort().join(" ")}`,
        `\n    output keywords: ${[...keywords(tool["outputSchema"])].sort().join(" ")}`,
      ].join(" ") + "\n",
    );
  }
}

await main();
