/**
 * Manage the Mandate Policy Stream through the QuickNode Streams REST API.
 * Reference: https://www.quicknode.com/docs/streams/rest-api
 *
 * Usage (from the repo root):
 *   npm run stream -w @mandate/streams -- <command> [options]
 *
 * Commands:
 *   status       Print the Stream's state and cursor, and the account's credit usage for the period.
 *   upsert       Create the Stream (paused), or update filter and destination of the existing one.
 *                Needs the budget confirmation (below).
 *   activate     Start or resume delivery. Credits are spent from this moment. Needs the budget confirmation.
 *   pause        The off switch: stop delivery and credit spend immediately; the cursor is kept.
 *   delete       Delete the Stream (requires --yes).
 *   test-filter  Run streams/filter.js against one real block without creating a Stream (requires --block).
 *
 * Options:
 *   --dry-run                     Print every request instead of sending it; needs no API key.
 *   --yes-i-checked-the-budget    Confirms `upsert` and `activate`; or set QUICKNODE_STREAM_BUDGET_CONFIRMED=yes.
 *   --allow-backfill              Allows a start block more than 10,000 blocks behind the tip.
 *   --env-file <path>             Env file to load (default: the repo root .env).
 *   --id <uuid>                   Act on this Stream instead of looking it up by external_id.
 *   --block <n>                   Block for test-filter.
 *   --yes                         Confirms delete.
 *
 * Environment (from the process, then from the env file):
 *   QUICKNODE_API_KEY                API key with the Streams application (and Admin API access for usage). Never printed.
 *   QUICKNODE_STREAM_SECURITY_TOKEN  HMAC secret shared with the webhook route, at least 32 characters. Never printed.
 *   QUICKNODE_STREAM_WEBHOOK_URL     Public HTTPS URL of the webhook route.
 *   POLICY_ADDRESS                   Policy contract address; comma-separate several.
 *   QUICKNODE_STREAM_TOPICS          Optional comma-separated topic0 allowlist.
 *   QUICKNODE_STREAM_NETWORK         arc-testnet (default) or arc-mainnet.
 *   QUICKNODE_STREAM_START_BLOCK     Optional first block. Unset means the chain tip, which is the default
 *                                    and the cheapest; an old block costs 20 credits per block behind the tip.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

import {
  BUILD_PLAN_MONTHLY_CREDITS,
  LOGS_CREDITS_PER_BLOCK,
  MAX_UNCONFIRMED_BACKFILL_BLOCKS,
  creditsPerDay,
  estimateBackfill,
} from "../src/budget";
import { encodeFilter, readFilterTemplate, renderFilter } from "../src/filter-source";
import {
  STREAM_NETWORKS,
  buildCreateBody,
  buildUpdateBody,
  externalIdFor,
  type StreamInputs,
  type StreamNetwork,
} from "../stream.config";

const API_ORIGIN = "https://api.quicknode.com";
const STREAMS = "/streams/rest/v1";
// Public, keyless RPC used only to read the chain tip for the backfill guard (no account credits).
const PUBLIC_RPC: Partial<Record<StreamNetwork, string>> = {
  "arc-testnet": "https://rpc.quicknode.testnet.arc.io",
};
const COMMANDS = ["status", "upsert", "activate", "pause", "delete", "test-filter"] as const;
type Command = (typeof COMMANDS)[number];
const BUDGET_FLAG = "yes-i-checked-the-budget";
const BUDGET_ENV = "QUICKNODE_STREAM_BUDGET_CONFIRMED";

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
// https://www.quicknode.com/docs/admin-api/usage/v0-usage-rpc
const usageSchema = z.object({
  data: z
    .object({
      credits_used: z.number().nullish(),
      credits_remaining: z.number().nullish(),
      limit: z.number().nullish(),
      overages: z.number().nullish(),
      start_time: z.number().nullish(),
      end_time: z.number().nullish(),
    })
    .nullish(),
  error: z.string().nullish(),
});

class UsageError extends Error {}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function loadEnvFile(path: string | undefined): void {
  const resolved = path ?? fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(resolved)) process.loadEnvFile(resolved);
  else if (path !== undefined) throw new UsageError(`Env file not found: ${path}`);
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

const formatCredits = (credits: number): string => credits.toLocaleString("en-US");

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

  /** Sends a request to api.quicknode.com, or prints it under --dry-run and returns undefined. */
  async send(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const url = `${API_ORIGIN}${path}`;
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
      const shown = JSON.stringify(redact(parsed)).split(this.apiKey).join("<redacted>");
      throw new HttpError(`${method} ${path} failed with HTTP ${response.status}: ${shown}`, response.status);
    }
    return parsed;
  }
}

interface Context {
  readonly client: Client;
  readonly dryRun: boolean;
  readonly network: StreamNetwork;
  readonly id: string | undefined;
  readonly budgetConfirmed: boolean;
  readonly allowBackfill: boolean;
}

function required(name: string, dryRun: boolean): string {
  const value = env(name);
  if (value !== undefined) return value;
  if (dryRun) return `<${name}>`;
  throw new UsageError(`${name} is not set`);
}

function dailyBurnText(): string {
  const perDay = creditsPerDay();
  return (
    `An active Stream spends about ${formatCredits(perDay)} credits per day ` +
    `(${LOGS_CREDITS_PER_BLOCK} credits per block, one Arc block every 0.5 s), ` +
    `${((perDay / BUILD_PLAN_MONTHLY_CREDITS) * 100).toFixed(1)}% of the Build plan's ` +
    `${formatCredits(BUILD_PLAN_MONTHLY_CREDITS)} monthly credits.`
  );
}

/** Refuses credit-spending actions until someone has confirmed the budget. */
function requireBudgetConfirmation(ctx: Context, action: string): void {
  if (ctx.dryRun || ctx.budgetConfirmed) return;
  throw new UsageError(
    `${action} spends API credits. ${dailyBurnText()}\n` +
      `Run \`status\` to see the credits left this period, then pass --${BUDGET_FLAG} ` +
      `(or set ${BUDGET_ENV}=yes). Use \`pause\` to stop spending.`,
  );
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

async function chainTip(network: StreamNetwork): Promise<number | undefined> {
  const url = PUBLIC_RPC[network];
  if (url === undefined) return undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const { result } = z.object({ result: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await response.json());
  return Number(BigInt(result));
}

/** Never backfills from an old block unless explicitly allowed, and always prints the cost. */
async function checkStartBlock(ctx: Context, startBlock: number | undefined): Promise<void> {
  if (startBlock === undefined) {
    console.log("Start: the chain tip (no backfill).");
    return;
  }
  const tip = await chainTip(ctx.network);
  if (tip === undefined) {
    if (!ctx.allowBackfill && !ctx.dryRun) {
      throw new UsageError(
        `Cannot read the ${ctx.network} tip to price a backfill from block ${startBlock}; pass --allow-backfill or unset QUICKNODE_STREAM_START_BLOCK`,
      );
    }
    return;
  }
  const estimate = estimateBackfill(startBlock, tip);
  console.log(
    `Start: block ${startBlock}, ${formatCredits(estimate.blocks)} blocks behind the tip (${tip}), ` +
      `a one-time backfill of about ${formatCredits(estimate.credits)} credits.`,
  );
  if (estimate.needsConfirmation && !ctx.allowBackfill && !ctx.dryRun) {
    throw new UsageError(
      `That backfill is more than ${formatCredits(MAX_UNCONFIRMED_BACKFILL_BLOCKS)} blocks; ` +
        `pass --allow-backfill if it is intended, or unset QUICKNODE_STREAM_START_BLOCK to start at the tip.`,
    );
  }
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
    const found = await ctx.client.send("GET", `${STREAMS}/streams/${ctx.id}`);
    return found === undefined ? undefined : streamSchema.parse(found);
  }
  const query = new URLSearchParams({ external_id: externalIdFor(ctx.network) });
  const found = await ctx.client.send("GET", `${STREAMS}/streams?${query.toString()}`);
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
  requireBudgetConfirmation(ctx, "upsert");
  const inputs = streamInputs(ctx);
  // Priced and refused before any API call; only a create uses the start block.
  await checkStartBlock(ctx, inputs.startBlock);
  const existing = await findStream(ctx);

  if (existing === undefined) {
    if (ctx.dryRun) console.log("[dry-run] If no Stream exists yet, the script creates it (paused):");
    // One key per create: each demo window deletes its Stream and creates a new one at the tip, and a key
    // reused after a delete could be answered with the deleted Stream. The lookup by external_id above is
    // what keeps a second run from creating a duplicate.
    const created = await ctx.client.send("POST", `${STREAMS}/streams`, buildCreateBody(inputs), {
      "idempotency-key": `${externalIdFor(ctx.network)}-${Date.now()}`,
    });
    if (ctx.dryRun) {
      console.log("[dry-run] If it exists, the script pauses it if active, then updates it:");
      await ctx.client.send("PATCH", `${STREAMS}/streams/<stream-id>`, buildUpdateBody(inputs));
      return;
    }
    const stream = streamSchema.parse(created);
    print("Created (paused, spending nothing). Run `activate` to start delivery.", summarize(stream));
    return;
  }

  if (existing.network !== ctx.network || existing.dataset !== "logs") {
    throw new UsageError(
      `Stream ${existing.id} is ${existing.network}/${existing.dataset}; network and dataset cannot be changed, delete it first`,
    );
  }
  // An update never moves the start block, so it cannot trigger a backfill.
  const wasActive = existing.status === "active";
  const base = `${STREAMS}/streams/${existing.id}`;
  if (wasActive) await ctx.client.send("POST", `${base}/pause`);
  await ctx.client.send("PATCH", base, buildUpdateBody(inputs));
  if (wasActive) await ctx.client.send("POST", `${base}/activate`);
  print(`Updated Stream ${existing.id}${wasActive ? " and reactivated it" : " (still paused)"}.`, {});
}

async function printUsage(ctx: Context): Promise<void> {
  let raw: unknown;
  try {
    raw = await ctx.client.send("GET", "/v0/usage/rpc");
  } catch (error) {
    if (error instanceof HttpError) {
      console.log(
        `Credit usage unavailable (${error.message}). Check https://dashboard.quicknode.com/billing instead; ` +
          "the key may need Admin API access.",
      );
      return;
    }
    throw error;
  }
  if (raw === undefined) return;
  const usage = usageSchema.parse(raw).data;
  if (usage === null || usage === undefined) {
    console.log("Credit usage unavailable: empty response.");
    return;
  }
  const period = (seconds: number | null | undefined) =>
    seconds === null || seconds === undefined ? "?" : new Date(seconds * 1000).toISOString();
  print("Account credits this period (all products, GET /v0/usage/rpc)", {
    period: `${period(usage.start_time)} to ${period(usage.end_time)}`,
    used: usage.credits_used,
    remaining: usage.credits_remaining,
    limit: usage.limit,
    overages: usage.overages,
  });
  if ((usage.overages ?? 0) > 0) console.log("WARNING: the account is in overage. Pause the Stream now.");
  if (typeof usage.credits_remaining === "number") {
    const days = usage.credits_remaining / creditsPerDay();
    console.log(
      `At the Stream's rate, the remaining credits last about ${days.toFixed(1)} days of activity.`,
    );
  }
}

async function status(ctx: Context): Promise<void> {
  const stream = await findStream(ctx);
  if (stream === undefined) {
    if (!ctx.dryRun) console.log(`No Stream with external_id ${externalIdFor(ctx.network)}.`);
  } else {
    print("Stream", summarize(stream));
    console.log(
      stream.status === "active"
        ? `${dailyBurnText()} Run \`pause\` to stop.`
        : "Not active: spending nothing.",
    );
  }
  await printUsage(ctx);
}

async function setStatus(ctx: Context, action: "activate" | "pause"): Promise<void> {
  if (action === "activate") requireBudgetConfirmation(ctx, "activate");
  const id = await requireStreamId(ctx);
  const result = await ctx.client.send("POST", `${STREAMS}/streams/${id}/${action}`);
  if (ctx.dryRun) return;
  print(`${action} ${id}`, result);
  console.log(
    action === "activate"
      ? `${dailyBurnText()} Run \`pause\` to stop.`
      : "Paused: spending nothing. The cursor is kept, so a later `activate` first delivers and bills " +
          "every block since now; at the end of a window run `delete --yes`, and `upsert` at the next one.",
  );
}

async function remove(ctx: Context, confirmed: boolean): Promise<void> {
  if (!confirmed && !ctx.dryRun) throw new UsageError("delete is permanent; pass --yes to confirm");
  const id = await requireStreamId(ctx);
  const result = await ctx.client.send("DELETE", `${STREAMS}/streams/${id}`);
  if (!ctx.dryRun) print(`Deleted ${id}`, result);
}

async function testFilter(ctx: Context, block: string | undefined): Promise<void> {
  if (block === undefined || !/^\d+$/.test(block)) throw new UsageError("test-filter needs --block <number>");
  const result = await ctx.client.send("POST", `${STREAMS}/streams/test_filter`, {
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
      [BUDGET_FLAG]: { type: "boolean", default: false },
      "allow-backfill": { type: "boolean", default: false },
      "env-file": { type: "string" },
      yes: { type: "boolean", default: false },
      id: { type: "string" },
      block: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(
      `Usage: quicknode-stream <${COMMANDS.join("|")}> [options]; see the header of this file`,
    );
  }

  loadEnvFile(values["env-file"]);
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
    budgetConfirmed: values[BUDGET_FLAG] || env(BUDGET_ENV) === "yes",
    allowBackfill: values["allow-backfill"],
  };

  switch (command as Command) {
    case "status":
      return status(ctx);
    case "upsert":
      return upsert(ctx);
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
