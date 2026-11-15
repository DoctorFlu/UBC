// QuickNode Streams filter: keep only the logs emitted by the Mandate Policy contract on Arc.
//
// Dataset: logs (stream.data is an array per block, of arrays per receipt, of raw EVM log objects).
// Runtime: QuickNode's JavaScript filter sandbox. The entry point must be a function named `main`.
// It may not use require, import, network access, fs or eval.
// Returning null skips delivery for the batch; credits are charged per block either way.
// Docs: https://www.quicknode.com/docs/streams/filters
//
// This file is uploaded as written, except for the two parameter lines below, which
// streams/src/filter-source.ts rewrites from the environment before base64 encoding.
// Keep each parameter on a single line so the rewrite stays exact.

// ---- Parameters (rewritten by streams/scripts/quicknode-stream.ts) ----
// Lowercase 0x-prefixed addresses of the Policy contract(s). Empty keeps nothing (fail closed).
const POLICY_ADDRESSES = [];
// topic0 values (keccak256 of the event signature) to keep. Empty keeps every event the contract emits.
const TOPIC0_ALLOWLIST = [];
// ---- End of parameters ----

// Also deliver batches with no matching logs, so the receiver sees the Stream's cursor advance.
// This is the liveness signal for the console; it costs no extra credits.
const EMIT_EMPTY_BATCHES = true;

// Must match FILTER_SCHEMA in streams/src/payload.ts.
const SCHEMA = "mandate.quicknode.policy-logs/v1";

// The nesting of stream.data differs by dataset and batch size, so walk it and collect
// anything that looks like a log instead of indexing into a fixed depth.
function collectLogs(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectLogs(item, output);
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    typeof value.address === "string" &&
    Array.isArray(value.topics) &&
    typeof value.data === "string"
  ) {
    output.push(value);
  }
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

// QuickNode calls main; nothing in this file does.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function main(stream) {
  const metadata = (stream && stream.metadata) || {};
  const addresses = new Set(POLICY_ADDRESSES.map(lower));
  const topics = new Set(TOPIC0_ALLOWLIST.map(lower));

  const raw = [];
  collectLogs((stream && stream.data) || [], raw);

  const logs = [];
  for (const log of raw) {
    if (!addresses.has(lower(log.address))) continue;
    if (topics.size > 0 && !topics.has(lower(log.topics[0]))) continue;
    // Keep the raw hex fields exactly as eth_getLogs returns them, so the receiver
    // normalizes Stream logs and RPC logs with the same code.
    const compact = {
      address: lower(log.address),
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      removed: log.removed === true,
    };
    if (typeof log.blockTimestamp === "string") compact.blockTimestamp = log.blockTimestamp;
    logs.push(compact);
  }

  if (logs.length === 0 && !EMIT_EMPTY_BATCHES) return null;

  // With a filter, the delivered body is this return value. The signature covers the body
  // but not the Stream-* and Batch-* headers, so the batch metadata is echoed here.
  return {
    schema: SCHEMA,
    network: metadata.network ?? null,
    stream_id: metadata.stream_id ?? null,
    batch_start_range: metadata.batch_start_range ?? null,
    batch_end_range: metadata.batch_end_range ?? null,
    blocks_reorged: metadata.blocks_reorged ?? null,
    logs,
  };
}
