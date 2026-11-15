import { z } from "zod";

/** Must match SCHEMA in streams/filter.js. */
export const FILTER_SCHEMA = "mandate.quicknode.policy-logs/v1";

export type Hex = `0x${string}`;

/**
 * One EVM log in the shape viem's `getLogs` returns for a mined block
 * (viem `Log<bigint, number, false>` without decoded args), so a single
 * decoder serves both the QuickNode Stream and the RPC poller.
 */
export interface ArcLog {
  address: Hex;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp?: bigint | undefined;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

export interface StreamBatchInfo {
  /** Streams network slug, for example `arc-testnet`. */
  readonly network: string | null;
  readonly streamId: string | null;
  /** First block of the batch, inclusive. */
  readonly startBlock: bigint | null;
  /** Last block of the batch, inclusive. */
  readonly endBlock: bigint | null;
  /** Blocks re-delivered after a reorg. Always empty on Arc, which has deterministic finality. */
  readonly blocksReorged: readonly bigint[];
}

export interface StreamBatch {
  /** `filter` for the envelope produced by streams/filter.js, `dataset` for an unfiltered `logs` payload. */
  readonly source: "filter" | "dataset";
  readonly batch: StreamBatchInfo;
  /** Logs ordered by block number, then log index. */
  readonly logs: readonly ArcLog[];
}

export class StreamPayloadError extends Error {
  override readonly name = "StreamPayloadError";
}

const hexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "expected even-length 0x hex");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte 0x hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 20-byte 0x hex address");
// JSON-RPC quantities are 0x hex. Plain integers are accepted for robustness.
const quantity = z.union([
  z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "expected 0x hex quantity"),
  z.number().int().nonnegative(),
]);

const rpcLog = z.object({
  address,
  topics: z.array(bytes32).max(4),
  data: hexData,
  blockNumber: quantity,
  blockHash: bytes32,
  blockTimestamp: quantity.nullish(),
  transactionHash: bytes32,
  transactionIndex: quantity,
  logIndex: quantity,
  removed: z.boolean().optional(),
});
type RpcLog = z.infer<typeof rpcLog>;

const blockRange = z.number().int().nullish();
const blocksReorged = z.array(z.number().int().nonnegative()).nullish();

const filterEnvelope = z.object({
  schema: z.literal(FILTER_SCHEMA),
  network: z.string().nullish(),
  stream_id: z.string().nullish(),
  batch_start_range: blockRange,
  batch_end_range: blockRange,
  blocks_reorged: blocksReorged,
  logs: z.array(rpcLog),
});

// https://www.quicknode.com/docs/streams/data-sources#payload-structure
const datasetMetadata = z.object({
  network: z.string().nullish(),
  dataset: z.string().nullish(),
  stream_id: z.string().nullish(),
  batch_start_range: blockRange,
  batch_end_range: blockRange,
  blocks_reorged: blocksReorged,
});

// The logs dataset nests arrays per block and per receipt; accept any depth.
type Nested = RpcLog | Nested[];
const nestedLogs: z.ZodType<Nested> = z.lazy(() => z.union([z.array(nestedLogs), rpcLog]));
const datasetPayload = z.object({
  data: z.array(nestedLogs),
  metadata: datasetMetadata,
});

function flatten(value: Nested, output: RpcLog[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, output);
  } else {
    output.push(value);
  }
}

const toBigInt = (value: string | number): bigint => BigInt(value);
const toIndex = (value: string | number): number => {
  const index = Number(value);
  if (!Number.isSafeInteger(index)) throw new StreamPayloadError(`Index out of range: ${String(value)}`);
  return index;
};

function normalizeLog(log: RpcLog): ArcLog {
  const normalized: ArcLog = {
    address: log.address.toLowerCase() as Hex,
    topics: log.topics.map((topic) => topic.toLowerCase() as Hex) as ArcLog["topics"],
    data: log.data.toLowerCase() as Hex,
    blockNumber: toBigInt(log.blockNumber),
    blockHash: log.blockHash.toLowerCase() as Hex,
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    transactionIndex: toIndex(log.transactionIndex),
    logIndex: toIndex(log.logIndex),
    removed: log.removed ?? false,
  };
  if (log.blockTimestamp !== undefined && log.blockTimestamp !== null) {
    normalized.blockTimestamp = toBigInt(log.blockTimestamp);
  }
  return normalized;
}

function byPosition(a: ArcLog, b: ArcLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

function toBatchInfo(meta: {
  network?: string | null | undefined;
  stream_id?: string | null | undefined;
  batch_start_range?: number | null | undefined;
  batch_end_range?: number | null | undefined;
  blocks_reorged?: number[] | null | undefined;
}): StreamBatchInfo {
  const range = (value: number | null | undefined): bigint | null =>
    value === null || value === undefined || value < 0 ? null : BigInt(value);
  return {
    network: meta.network ?? null,
    streamId: meta.stream_id ?? null,
    startBlock: range(meta.batch_start_range),
    endBlock: range(meta.batch_end_range),
    blocksReorged: (meta.blocks_reorged ?? []).map((block) => BigInt(block)),
  };
}

function fail(what: string, error: z.ZodError): never {
  throw new StreamPayloadError(`Invalid ${what}:\n${z.prettifyError(error)}`);
}

const hasSchema = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "schema" in value;

/**
 * Finds the filter envelope in a body. The docs say a filter's return value is what gets delivered,
 * but do not show a filtered webhook body, so `{ data: envelope }` and `{ data: [envelope] }`
 * wrappings are accepted too until a live delivery settles it.
 */
function findEnvelope(body: unknown): unknown {
  if (hasSchema(body)) return body;
  if (typeof body !== "object" || body === null || !("data" in body)) return undefined;
  const { data } = body;
  if (hasSchema(data)) return data;
  if (Array.isArray(data) && data.length === 1 && hasSchema(data[0])) return data[0];
  return undefined;
}

/**
 * Validates a Streams webhook body (already JSON-parsed) and returns its logs and batch metadata.
 * Accepts the envelope produced by streams/filter.js and, for tests and backfills without the
 * filter, the unfiltered `logs` dataset payload.
 */
export function parseStreamBatch(body: unknown): StreamBatch {
  const envelope = findEnvelope(body);
  if (envelope !== undefined) {
    const parsed = filterEnvelope.safeParse(envelope);
    if (!parsed.success) fail("Mandate filter envelope", parsed.error);
    return {
      source: "filter",
      batch: toBatchInfo(parsed.data),
      logs: parsed.data.logs.map(normalizeLog).sort(byPosition),
    };
  }

  const parsed = datasetPayload.safeParse(body);
  if (!parsed.success) fail("Streams logs dataset payload", parsed.error);
  const { dataset } = parsed.data.metadata;
  if (dataset !== undefined && dataset !== null && dataset !== "logs") {
    throw new StreamPayloadError(`Expected the logs dataset, got ${dataset}`);
  }
  const raw: RpcLog[] = [];
  for (const item of parsed.data.data) flatten(item, raw);
  return {
    source: "dataset",
    batch: toBatchInfo(parsed.data.metadata),
    logs: raw.map(normalizeLog).sort(byPosition),
  };
}

/** The flat, ordered list of logs in a Streams webhook body. See {@link parseStreamBatch}. */
export function parseStreamPayload(body: unknown): ArcLog[] {
  return [...parseStreamBatch(body).logs];
}
