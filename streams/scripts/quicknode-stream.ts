/**
 * Manage the Mandate Policy Stream through the QuickNode Streams REST API.
 * Reference: https://www.quicknode.com/docs/streams/rest-api
 *
 * Usage (from the repo root):
 *   npm run stream -w @mandate/streams -- <command> [--dry-run] [--id <uuid>] [--block <n>] [--yes]
 *
 * Commands:
 *   upsert       Create the Stream (paused), or update filter and destination of the existing one.
 *   show         Print the Stream's status and cursor.
 *   activate     Start or resume delivery.
 *   pause        Stop delivery; the cursor is kept.
 *   delete       Delete the Stream (requires --yes).
 *   test-filter  Run streams/filter.js against one real block without creating a Stream (requires --block).
 *
 * Environment (read from the process, then from the repo root .env):
 *   QUICKNODE_API_KEY                Streams REST API key (header x-api-key). Never printed.
 *   QUICKNODE_STREAM_SECURITY_TOKEN  HMAC secret shared with the webhook route, at least 32 characters. Never printed.
 *   QUICKNODE_STREAM_WEBHOOK_URL     Public HTTPS URL of the webhook route.
 *   POLICY_ADDRESS                   Policy contract address; comma-separate several.
 *   QUICKNODE_STREAM_TOPICS          Optional comma-separated topic0 allowlist.
 *   QUICKNODE_STREAM_NETWORK         arc-testnet (default) or arc-mainnet.
 *   QUICKNODE_STREAM_START_BLOCK     Optional first block, normally the Policy deploy block.
 *
 * --dry-run prints every request instead of sending it and needs no API key.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

import { encodeFilter, readFilterTemplate, renderFilter } from "../src/filter-source";
import {
  STREAM_NETWORKS,
  buildCreateBody,
  buildUpdateBody,
  externalIdFor,
  type StreamInputs,
  type StreamNetwork,
} from "../stream.config";

const API_BASE = "https://api.quicknode.com/streams/rest/v1";
const COMMANDS = ["upsert", "show", "activate", "pause", "delete", "test-filter"] as const;
type Command = (typeof COMMANDS)[number];

// Stream ids are UUIDs; anything else is refused before it reaches a request path.
const STREAM_ID = /^[0-9a-zA-Z-]{1,64}$/;

const streamSchema = z.object({
  id: z.string().regex(STREAM_ID),
  name: z.string().nullish(),
  network: z.string(),
  dataset: z.string(),
  status: z.string(),
  sequence: z.number().nullish(),
  start_range: z.number().nullish(),
  end_range: z.number().nullish(),
  destination_attributes: z.object({ url: z.string().nullish() }).loose().nullish(),
});
type Stream = z.infer<typeof streamSchema>;
const streamListSchema = z.object({ data: z.array(streamSchema) });
const testFilterSchema = z.object({ logs: z.array(z.unknown()).nullish(), result: z.unknown() });

class UsageError extends Error {}

function loadDotEnv(): void {
  const path = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Replaces secrets and the long base64 filter before anything is printed. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "security_token" || key.toLowerCase() === "x-api-key") out[key] = "<redacted>";
    else if (key === "filter_function" && typeof inner === "string")
      out[key] = `<base64 of the rendered filter, ${inner.length} chars>`;
    else out[key] = redact(inner);
  }
  return out;
}

function print(label: string, value: unknown): void {
  console.log(`${label}\n${JSON.stringify(redact(value), null, 2)}`);
}

class Client {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly dryRun: boolean,
  ) {}

  /** Sends a request, or prints it under --dry-run and returns undefined. */
  async send(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const url = `${API_BASE}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    };
    if (this.dryRun) {
      print(`[dry-run] ${method} ${url}`, { headers: { ...headers, "x-api-key": "<redacted>" }, body });
      return undefined;
    }
    if (this.apiKey === undefined) throw new UsageError("QUICKNODE_API_KEY is not set");
    const response = await fetch(url, {
      method,
      headers: { ...headers, "x-api-key": this.apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      // Keep the raw text for the error message.
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed with HTTP ${response.status}: ${JSON.stringify(redact(parsed))}`,
      );
    }
    return parsed;
  }
}

interface Context {
  readonly client: Client;
  readonly dryRun: boolean;
  readonly network: StreamNetwork;
  readonly id: string | undefined;
}

function required(name: string, dryRun: boolean): string {
  const value = env(name);
  if (value !== undefined) return value;
  if (dryRun) return `<${name}>`;
  throw new UsageError(`${name} is not set`);
}

function filterFunction(dryRun: boolean): string {
  const addresses = list(env("POLICY_ADDRESS"));
  if (addresses.length === 0) {
    if (!dryRun) throw new UsageError("POLICY_ADDRESS is not set");
    addresses.push(`0x${"0".repeat(40)}`);
    console.log("[dry-run] POLICY_ADDRESS is not set; rendering the filter with the zero address");
  }
  const source = renderFilter(readFilterTemplate(), {
    addresses,
    topics: list(env("QUICKNODE_STREAM_TOPICS")),
  });
  if (dryRun) {
    const parameters = source
      .split("\n")
      .filter((line) => /^const (POLICY_ADDRESSES|TOPIC0_ALLOWLIST) =/.test(line));
    console.log(`[dry-run] filter_function is streams/filter.js with:\n${parameters.join("\n")}`);
  }
  return encodeFilter(source);
}

function streamInputs(ctx: Context): StreamInputs {
  const webhookUrl = required("QUICKNODE_STREAM_WEBHOOK_URL", ctx.dryRun);
  if (!ctx.dryRun && !webhookUrl.startsWith("https://")) {
    throw new UsageError("QUICKNODE_STREAM_WEBHOOK_URL must be an https:// URL reachable from the internet");
  }
  const securityToken = required("QUICKNODE_STREAM_SECURITY_TOKEN", ctx.dryRun);
  if (!ctx.dryRun && securityToken.length < 32) {
    throw new UsageError("QUICKNODE_STREAM_SECURITY_TOKEN must be at least 32 characters");
  }
  const start = env("QUICKNODE_STREAM_START_BLOCK");
  if (start !== undefined && !/^\d+$/.test(start)) {
    throw new UsageError("QUICKNODE_STREAM_START_BLOCK must be a block number");
  }
  return {
    network: ctx.network,
    filterFunction: filterFunction(ctx.dryRun),
    webhookUrl,
    securityToken,
    startBlock: start === undefined ? undefined : Number(start),
  };
}

/** Finds the Stream by --id, or by its external_id. Returns undefined when it does not exist. */
async function findStream(ctx: Context): Promise<Stream | undefined> {
  if (ctx.id !== undefined) {
    const found = await ctx.client.send("GET", `/streams/${ctx.id}`);
    return found === undefined ? undefined : streamSchema.parse(found);
  }
  const query = new URLSearchParams({ external_id: externalIdFor(ctx.network) });
  const found = await ctx.client.send("GET", `/streams?${query.toString()}`);
  if (found === undefined) return undefined;
  return streamListSchema.parse(found).data[0];
}

async function requireStreamId(ctx: Context): Promise<string> {
  const stream = await findStream(ctx);
  if (stream !== undefined) return stream.id;
  if (ctx.dryRun) return "<stream-id>";
  throw new UsageError(`No Stream with external_id ${externalIdFor(ctx.network)}; run upsert first`);
}

function summarize(stream: Stream): Record<string, unknown> {
  return {
    id: stream.id,
    name: stream.name,
    network: stream.network,
    dataset: stream.dataset,
    status: stream.status,
    sequence: stream.sequence,
    start_range: stream.start_range,
    end_range: stream.end_range,
    webhook: stream.destination_attributes?.url,
  };
}

async function upsert(ctx: Context): Promise<void> {
  const inputs = streamInputs(ctx);
  const existing = await findStream(ctx);

  if (existing === undefined) {
    if (ctx.dryRun) console.log("[dry-run] If no Stream exists yet, the script creates it:");
    const created = await ctx.client.send("POST", "/streams", buildCreateBody(inputs), {
      "idempotency-key": externalIdFor(ctx.network),
    });
    if (ctx.dryRun) {
      console.log("[dry-run] If it exists, the script pauses it if active, then updates it:");
      await ctx.client.send("PATCH", "/streams/<stream-id>", buildUpdateBody(inputs));
      return;
    }
    const stream = streamSchema.parse(created);
    print("Created (paused). Run `activate` to start delivery.", summarize(stream));
    return;
  }

  if (existing.network !== ctx.network || existing.dataset !== "logs") {
    throw new UsageError(
      `Stream ${existing.id} is ${existing.network}/${existing.dataset}; network and dataset cannot be changed, delete it first`,
    );
  }
  const wasActive = existing.status === "active";
  if (wasActive) await ctx.client.send("POST", `/streams/${existing.id}/pause`);
  await ctx.client.send("PATCH", `/streams/${existing.id}`, buildUpdateBody(inputs));
  if (wasActive) await ctx.client.send("POST", `/streams/${existing.id}/activate`);
  print(`Updated Stream ${existing.id}${wasActive ? " and reactivated it" : " (still paused)"}.`, {});
}

async function show(ctx: Context): Promise<void> {
  const stream = await findStream(ctx);
  if (stream === undefined) {
    if (!ctx.dryRun) console.log(`No Stream with external_id ${externalIdFor(ctx.network)}`);
    return;
  }
  print("Stream", summarize(stream));
}

async function setStatus(ctx: Context, action: "activate" | "pause"): Promise<void> {
  const id = await requireStreamId(ctx);
  const result = await ctx.client.send("POST", `/streams/${id}/${action}`);
  if (!ctx.dryRun) print(`${action} ${id}`, result);
}

async function remove(ctx: Context, confirmed: boolean): Promise<void> {
  if (!confirmed && !ctx.dryRun) throw new UsageError("delete is permanent; pass --yes to confirm");
  const id = await requireStreamId(ctx);
  const result = await ctx.client.send("DELETE", `/streams/${id}`);
  if (!ctx.dryRun) print(`Deleted ${id}`, result);
}

async function testFilter(ctx: Context, block: string | undefined): Promise<void> {
  if (block === undefined || !/^\d+$/.test(block)) throw new UsageError("test-filter needs --block <number>");
  const result = await ctx.client.send("POST", "/streams/test_filter", {
    network: ctx.network,
    dataset: "logs",
    filter_function: filterFunction(ctx.dryRun),
    filter_language: "javascript",
    block,
  });
  if (result === undefined) return;
  const parsed = testFilterSchema.parse(result);
  let output = parsed.result;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output) as unknown;
    } catch {
      // Not JSON; print as returned.
    }
  }
  print("Filter console output", parsed.logs ?? []);
  print("Filter result", output);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      id: { type: "string" },
      block: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(
      `Usage: quicknode-stream <${COMMANDS.join("|")}> [--dry-run] [--id <uuid>] [--block <n>] [--yes]`,
    );
  }

  loadDotEnv();
  const network = env("QUICKNODE_STREAM_NETWORK") ?? "arc-testnet";
  if (!(STREAM_NETWORKS as readonly string[]).includes(network)) {
    throw new UsageError(`QUICKNODE_STREAM_NETWORK must be one of ${STREAM_NETWORKS.join(", ")}`);
  }
  if (values.id !== undefined && !STREAM_ID.test(values.id))
    throw new UsageError("--id must be a Stream UUID");
  const dryRun = values["dry-run"];
  const ctx: Context = {
    client: new Client(env("QUICKNODE_API_KEY"), dryRun),
    dryRun,
    network: network as StreamNetwork,
    id: values.id,
  };

  switch (command as Command) {
    case "upsert":
      return upsert(ctx);
    case "show":
      return show(ctx);
    case "activate":
      return setStatus(ctx, "activate");
    case "pause":
      return setStatus(ctx, "pause");
    case "delete":
      return remove(ctx, values.yes);
    case "test-filter":
      return testFilter(ctx, values.block);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
