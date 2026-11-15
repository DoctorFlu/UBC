# QuickNode Streams on Arc testnet (spike #5)

This spike answers whether a QuickNode Stream can be the console's live data source on Arc testnet, and prepares everything so the Stream can be created by script the moment an API key exists.
Nobody on the team has a QuickNode account yet, so nothing here was created on QuickNode.
Research date: 2026-11-15.

Every claim is tagged:

- **verified in docs** with the page it comes from,
- **verified live** when checked against a public endpoint without an account,
- **unverified** when it is an inference or an open question that the first real delivery must settle.

## Answer in one paragraph

Arc testnet is supported by Streams today, as network `arc-testnet` with dataset `logs`, and Arc mainnet is supported as `arc-mainnet`.
A JavaScript filter keeps only the Policy contract's logs and a webhook destination delivers them, signed with HMAC-SHA256 over `nonce + timestamp + body`.
The Free trial includes Streams with one active Stream and one webhook destination, but at Arc's block rate a continuously running Stream spends the trial's 10M credits in about 3 to 4 days, so the Stream should stay paused outside development and demo windows.
No fallback is needed.

## 1. Is Arc testnet supported?

Yes.

- The Streams supported-chains table lists both `Arc | Mainnet` and `Arc | Testnet` with Block, Block with Receipts, Transactions, Logs, Receipts, both trace datasets and both composite trace datasets; only Validator Activity is missing.
  Verified in docs: https://www.quicknode.com/docs/streams/supported-chains
- The changelog entry dated September 22, 2026 reads "Streams & Webhooks added support for Arc Testnet and GIWA Sepolia Testnet".
  Verified in docs: https://www.quicknode.com/docs/changelog
- The exact network identifiers in the REST API are `arc-testnet` and `arc-mainnet`.
  They are in the `network` enum of both `CreateStreamDto` and `TestFilterFunctionDto`.
  Verified in docs: https://api.quicknode.com/streams/rest/openapi.json
- QuickNode's Arc overview lists Testnet (chain id 5042002) and Mainnet (chain id 5042), both archive with no pruning, and names Streams and Webhooks as supported products.
  Verified in docs: https://www.quicknode.com/docs/arc/api-overview
- QuickNode's own Arc Streams guide uses `"network": "arc-mainnet"` with `"dataset": "logs"` and tests filters against real Arc blocks.
  Verified in docs: https://www.quicknode.com/guides/arc/index-arc-usdc-movements-with-streams
- The Arc chain page says "Connect to Arc Mainnet and Testnet with low-latency RPC, full archive data, debug and trace APIs, and real-time Streams" and contains no "Coming soon" text today.
  Verified in docs: https://www.quicknode.com/chains/arc
- The reported "Coming Soon" wording does not appear on any current QuickNode page I fetched (Arc overview, Arc chain page, supported chains).
  A search engine snippet still attributes "Additional Quicknode products for Arc are coming soon" to the Arc overview, which is most likely a stale cache from before the September 22 change.
  Unverified as to where it was originally shown; the current pages above are authoritative.
- The Streams billing calculator data lists `arc-testnet` and `arc-mainnet` with `hasBackfill: true` and a 500 ms block time.
  Verified in docs (calculator data bundled in https://www.quicknode.com/docs/streams/billing).

## 2. Datasets and payload shape

### Dataset names

The API dataset identifiers are `block`, `block_with_receipts`, `receipts`, `logs`, `transactions`, `trace_blocks`, `debug_traces`, `block_with_receipts_debug_trace` and `block_with_receipts_trace_block`, plus non-EVM ones.
Verified in docs: https://api.quicknode.com/streams/rest/openapi.json

We use `logs`.
It is the lightest dataset that carries everything the Policy decoder needs, and it costs the same per block as `receipts`.

### Envelope (every dataset)

A delivery is `{ "data": [...], "metadata": {...} }`.
Metadata is sent once per batch, both in the JSON body and as HTTP headers.
Verified in docs: https://www.quicknode.com/docs/streams/data-sources#payload-structure

| Body field | Header | Meaning |
| --- | --- | --- |
| `batch_start_range` | `Batch-Start-Range` | First block of the batch, inclusive |
| `batch_end_range` | `Batch-End-Range` | Last block of the batch, inclusive |
| `data_size_bytes` | `Batch-Data-Size-Bytes` | Size of the raw data |
| `blocks_reorged` | `Batch-Blocks-Reorged` | Block numbers re-delivered after a reorg, `null` in the body when empty |
| `reorgs` | `Batch-Reorgs` | Number, hash and timestamp of displaced blocks |
| `dataset` | `Stream-Dataset` | For example `logs` |
| `network` | `Stream-Network` | For example `arc-testnet` |
| `start_range`, `end_range` | `Stream-Start-Range`, `Stream-End-Range` | The Stream's configured range; `end_range` is `-1` for a tip Stream |
| `keep_distance_from_tip` | `Stream-Keep-Distance-From-Tip` | Blocks kept behind the tip |
| `stream_id`, `stream_name`, `stream_region` | `Stream-Id`, `Stream-Name`, `Stream-Region` | Identity of the Stream |

Block numbers in metadata are JSON numbers (decimal).
Verified in docs (same page).

### Logs dataset

`data` is an array per block, of arrays per transaction receipt, of raw log objects exactly as they appear in `eth_getBlockReceipts`.
All quantities inside the logs are 0x hex strings.
Verified in docs: https://www.quicknode.com/docs/streams/data-sources/ethereum-evm#logs and the triple loop in https://www.quicknode.com/docs/streams/rest-api#using-filters-via-api

The documented example (Ethereum):

```json
{
  "data": [
    [
      [
        {
          "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          "topics": [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x000000000000000000000000d4bc53434c5e12cb41381a556c3c47e1a86e80e3",
            "0x00000000000000000000000011b815efb8f581194ae79006d24e0d814b7697f6"
          ],
          "data": "0x0000000000000000000000000000000000000000000000144cb0059dd91ec491",
          "blockNumber": "0x16263be",
          "transactionHash": "0x4cda2112bfb02ff07b3a88eced7e5f972ea2827bdcab448ae07d6330d62b30a2",
          "transactionIndex": "0x0",
          "blockHash": "0xb0587a2035660384c0a2f31bc2977f2dc60408618f67be97149d14b5fbc0741b",
          "logIndex": "0x0",
          "removed": false
        }
      ]
    ]
  ]
}
```

On Arc, logs also carry `blockTimestamp` (hex seconds).
Verified in docs (Arc guide above) and verified live: `eth_getLogs` on `https://rpc.quicknode.testnet.arc.io` returns `blockTimestamp` on every log.

Whether a receipt without logs appears as an empty array, and whether a block without receipts appears as an empty array, is not shown in the docs.
Unverified; the filter and the parser walk any nesting depth, so either shape works.

The recorded fixture `streams/test/fixtures/arc-testnet-logs-dataset.json` wraps real Arc testnet logs (blocks 72471363 to 72471367, 39 logs, fetched with `eth_getBlockReceipts` from the public QuickNode endpoint) in the documented envelope and nesting.
It is docs-derived in shape and real in content; it is not a captured Stream delivery.

### Receipts dataset (for comparison)

`data` is an array per block of arrays of receipt objects as returned by `eth_getBlockReceipts`, each with its own `logs` array.
Verified in docs: https://www.quicknode.com/docs/streams/data-sources/ethereum-evm#receipts

## 3. Filters

- The JavaScript entry point must be a function named `main`.
  It receives one object with `.data` and `.metadata`; the parameter name is arbitrary.
  Verified in docs: https://www.quicknode.com/docs/streams/filters#filter-execution-environment
- Returning an object, array or string delivers it; returning `null` skips delivery for that batch.
  Verified in docs (same page).
- Credits are charged per block processed whatever the filter returns, so filtering saves bandwidth, not credits.
  Verified in docs (same page) and https://www.quicknode.com/docs/streams/billing
- The sandbox has no `require`, `import`, network access, `fs` or `eval`.
  Helpers are `decodeEVMReceipts(receipts, abis)`, `qnLib.*` Key-Value Store calls (use `async function main` for those) and `console.log`, whose output shows in the dashboard's Logs tab and in the `logs` field of the test endpoint.
  Verified in docs (same page) and https://www.quicknode.com/docs/streams/filters/key-value-store
- Filters can also be written in Go (`func Filter(qn *qn.QNContext, payload Payload) interface{}`), selected with `filter_language: "go"`.
  Verified in docs (same page) and the OpenAPI spec.
- Over the API the filter is sent base64-encoded in `filter_function`.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api#using-filters-via-api
- Size and execution time limits for filters are not documented.
  Unverified.
- With a filter, the delivered body is the filter's return value.
  The filters page says the return value is what is delivered, and the Arc guide says a PostgreSQL row holds exactly the returned object, but no page shows a filtered webhook body.
  Unverified for webhooks; `parseStreamBatch` also accepts the envelope nested under `data` in case QuickNode wraps it.

Our filter is `streams/filter.js`.
It walks `stream.data`, keeps logs whose `address` is in `POLICY_ADDRESSES` and, when `TOPIC0_ALLOWLIST` is not empty, whose `topics[0]` is in it, and returns:

```json
{
  "schema": "mandate.quicknode.policy-logs/v1",
  "network": "arc-testnet",
  "stream_id": "f6ad6459-b5ad-4183-b370-1c1388e47e83",
  "batch_start_range": 72471363,
  "batch_end_range": 72471367,
  "blocks_reorged": null,
  "logs": [
    {
      "address": "0x1290b4f2a419a316467b580a088453a233e9adcc",
      "topics": ["0x46f6fe57...", "0x000000000000000000000000bf9d607f..."],
      "data": "0x000000000000000000000000000000000000000000000000000000000000001f",
      "blockNumber": "0x451d345",
      "blockHash": "0x906b3c8c...",
      "transactionHash": "0x258143b9...",
      "transactionIndex": "0x1",
      "logIndex": "0x4",
      "removed": false,
      "blockTimestamp": "0x6afa11cf"
    }
  ]
}
```

Design choices:

- The logs keep the raw hex fields of `eth_getLogs`, so the Stream and the RPC poller share one normalizer and one decoder.
- The batch range is echoed in the body because the HMAC covers the body but not the `Stream-*` and `Batch-*` headers.
- Empty batches are delivered too (`EMIT_EMPTY_BATCHES = true`), which gives the console a liveness signal and the Stream's cursor at no extra credit cost.
  Set it to `false` to return `null` instead.
- `POLICY_ADDRESSES` is empty in the committed file, so an unrendered filter keeps nothing.
  The script rewrites the two parameter lines from the environment before upload.

## 4. Webhook destination and signatures

### Configuration

| API field | Dashboard label | Notes |
| --- | --- | --- |
| `url` | Destination URL | HTTP(S) endpoint that receives POSTs |
| `compression` | Payload compression | `none` or `gzip`; compression is not on the Free plan |
| `headers` | Custom headers | Optional key-value pairs sent with every request |
| `max_retry` | Pause stream after | Failed attempts before the Stream pauses itself (dashboard default 3) |
| `retry_interval_sec` | Retry data fetch every | Seconds between attempts (dashboard default 1) |
| `post_timeout_sec` | Timeout | Seconds to wait for a response (dashboard default 30) |
| `security_token` | Security token | HMAC key; at least 32 characters when supplied, generated when omitted, returned in the Stream response |
| `mtls`, `ssl_ca_pem` | Enable mTLS, CA Certificate | Optional client-certificate authentication; requires HTTPS |

Verified in docs: https://www.quicknode.com/docs/streams/destinations/webhooks and https://www.quicknode.com/docs/streams/rest-api/create-stream

The OpenAPI schema marks `security_token` and `headers` as required while the create page marks them optional.
We always send both, which satisfies either reading.

### Delivery semantics

- The receiver must accept `POST` with `Content-Type: application/json` and return any 2xx within the timeout.
  Anything else is retried.
  Verified in docs: https://www.quicknode.com/docs/streams/destinations/webhooks#delivery-requirements
- Delivery is sequential: Streams does not move to the next batch until the current one is acknowledged, so order is preserved and a slow receiver slows the Stream.
  Verified in docs (same page).
- After `max_retry` failures the Stream pauses itself to avoid data loss, and someone must reactivate it.
  Verified in docs: https://www.quicknode.com/docs/streams/destinations
- Delivery is at least once in practice.
  The FAQ and the Arc overview promise "exactly-once delivery", but the destinations page says batches may be re-delivered after a restart, and reorg handling re-delivers blocks by design.
  Verified in docs: https://www.quicknode.com/docs/streams/faq and https://www.quicknode.com/docs/streams/destinations#multiple-destinations.
  Writes must be idempotent, keyed by transaction hash and log index.
- Failed deliveries and retries are not charged.
  Verified in docs: https://www.quicknode.com/docs/streams/billing
- Deliveries come from IP `141.148.40.227`.
  Verified in docs: https://www.quicknode.com/docs/streams/destinations/webhooks#ip-allowlisting

### Signature

Each delivery carries `X-QN-Nonce`, `X-QN-Timestamp` and `X-QN-Signature`.
The signature is the lowercase hex HMAC-SHA256 of the UTF-8 string `nonce + timestamp + body`, keyed with the Stream's security token.
With gzip, the HMAC is over the decompressed body, so decompress first and verify the decoded bytes.
The timestamp is unix seconds (the guide's sample output shows `1735613672`).
Verified in docs: https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages and the reference server https://github.com/quiknode-labs/streams-webhook-validate-signature

QuickNode publishes no test vectors.
The vectors in `streams/test/signature.test.ts` were computed independently with `openssl dgst -sha256 -hmac`.

`verifyQuickNodeSignature(headers, rawBody, securityToken, options?)` in `streams/src/signature.ts`:

- reads the three headers case-insensitively from a Fetch `Headers` or a Node header record,
- compares in constant time,
- rejects timestamps more than 300 seconds from now by default (`maxAgeSeconds`, or `null` to disable),
- returns `{ ok: true, nonce, timestamp }` or `{ ok: false, reason, detail }`.

Replay protection guidance for the webhook route (#19):

1. Read the raw body before any JSON parsing and verify over exactly those bytes.
2. Keep the 300 second window; it bounds how long a captured delivery stays usable.
3. Within the window, remember seen nonces (an in-memory set with expiry is enough for one server) and answer a repeat with 2xx without processing it, so QuickNode does not retry.
4. Make writes idempotent by `(transactionHash, logIndex)`, because QuickNode itself can re-deliver a batch with a fresh signature.
5. Return 401 only for a bad signature; return 2xx quickly and process asynchronously if processing can take longer than the timeout.

Whether a retry of the same batch is re-signed with a new nonce and timestamp is not documented.
Unverified; steps 3 and 4 make either behavior safe.

## 5. Stream lifecycle

- **Start block.** Omit `start_range` to start at the latest block; set it to backfill from that block.
  Without `end_range` (or with `-1`), a backfilling Stream continues into live delivery with no handoff.
  Verified in docs: https://api.quicknode.com/streams/rest/openapi.json and https://www.quicknode.com/docs/streams/backfilling
  Starting at the Policy deploy block makes the Stream rebuild full history by itself.
- **Batching.** `dataset_batch_size` blocks per filter run and delivery; with `elastic_batch_enabled`, whatever is ready at the tip is delivered without waiting for the batch to fill.
  Tip Streams on networks with sub-second blocks must use a batch size of at least 5, or the API returns 422.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api#batch-size-and-elastic-batch
  Arc qualifies: QuickNode's calculator assumes 500 ms blocks, Arc's docs say about 2 blocks per second, and I measured an average of 0.697 s over the 20,000 blocks ending at 72,471,391.
  Verified live.
- **Reorgs.** `fix_block_reorgs: 1` re-streams corrected blocks, `restream_batch_on_reorg` re-sends whole batches, and `keep_distance_from_tip` trails the tip.
  Reorg handling is not on the Free plan.
  Verified in docs: https://www.quicknode.com/docs/streams/reorg-handling and https://www.quicknode.com/pricing.md
  Arc has deterministic finality, so we set `fix_block_reorgs: 0` and `keep_distance_from_tip: 0`, as QuickNode's Arc guide does.
  Verified in docs: https://www.quicknode.com/guides/arc/index-arc-usdc-movements-with-streams
- **Pause and resume.** `POST /streams/{id}/pause` stops delivery and keeps the configuration and cursor; `POST /streams/{id}/activate` resumes from where it stopped.
  A paused Stream consumes no credits.
  The dashboard can also resume from the latest block, skipping the paused range.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api/pause-stream, https://www.quicknode.com/docs/streams/rest-api/activate-stream and https://www.quicknode.com/docs/streams/billing
- **States.** `active` and `paused` are the settable statuses; a bounded backfill ends `completed`, and a Stream whose destination is unreachable at activation can be `terminated` (`notification_email` alerts on termination).
  Verified in docs: the OpenAPI spec and the Arc guide; the full list of states is not documented.
- **Destination down.** Retries every `retry_interval_sec`, then pauses after `max_retry` attempts; nothing is skipped, and reactivating resumes at the failed batch.
  Verified in docs (section 4).
- **Immutable fields.** `network`, `dataset` and `region` cannot be changed by PATCH; they are absent from `UpdateStreamDto`.
  Verified in docs: the OpenAPI spec.
  Whether PATCH works on an active Stream is not documented, so the script pauses, patches and reactivates.
  Unverified.
- **Latency.** QuickNode markets "real-time" and "low-latency" but publishes no delivery latency figure.
  Unverified.
  Expect roughly one Arc block (under a second) plus filter time plus one HTTPS round trip with elastic batching; measure it on the first live run.

## 6. Programmatic control, plans and cost

### REST API

- Base URL `https://api.quicknode.com/streams/rest/v1`, authenticated with the `x-api-key` header.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api
  Verified live: an unauthenticated request returns HTTP 401 `{"error":{"code":401,"message":"Api key is missing under x-api-key header, please update and try again.","name":"AuthenticationError"}}`, which also shows the real error shape differs from the documented `{"error": "...", "status": 401}`.
- Endpoints: `POST /streams` (create), `GET /streams` (list, with `external_id`, `limit`, `offset`), `GET /streams/{id}`, `PATCH /streams/{id}`, `DELETE /streams/{id}`, `DELETE /streams` (all), `POST /streams/{id}/pause`, `POST /streams/{id}/activate`, `GET /streams/enabled_count`, `POST /streams/test_filter`.
  Verified in docs: the REST API page and the OpenAPI spec.
- Safe retries: send `external_id` (or the same value as an `Idempotency-Key` header); a repeated create returns the existing Stream with 200 instead of a duplicate.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api/create-stream#safe-retries-with-external_id
- API keys are created at https://dashboard.quicknode.com/api-keys with the Streams application enabled; the Streams API shares a plan-based rate limit with the Admin, Webhooks, Key-Value Store and SQL Explorer APIs.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api#authentication
- A Terraform provider (`quicknode_stream`) and a `qn` CLI also exist.
  Verified in docs: https://www.quicknode.com/docs/streams

Our complete create request (from `npm run stream -w @mandate/streams -- upsert --dry-run`, secrets redacted):

```json
{
  "name": "mandate-policy-logs-arc-testnet",
  "network": "arc-testnet",
  "dataset": "logs",
  "filter_function": "<base64 of streams/filter.js with POLICY_ADDRESSES filled in>",
  "filter_language": "javascript",
  "region": "usa_east",
  "start_range": 72471363,
  "dataset_batch_size": 5,
  "elastic_batch_enabled": true,
  "fix_block_reorgs": 0,
  "keep_distance_from_tip": 0,
  "destination": "webhook",
  "destination_attributes": {
    "url": "https://<public host>/api/streams/quicknode",
    "compression": "none",
    "headers": {},
    "max_retry": 5,
    "retry_interval_sec": 2,
    "post_timeout_sec": 10,
    "security_token": "<QUICKNODE_STREAM_SECURITY_TOKEN>"
  },
  "status": "paused",
  "external_id": "mandate-policy-logs-arc-testnet"
}
```

It is sent with headers `x-api-key: <QUICKNODE_API_KEY>`, `content-type: application/json` and `idempotency-key: mandate-policy-logs-arc-testnet`.
`start_range` is present only when `QUICKNODE_STREAM_START_BLOCK` is set.
The Stream is created paused; `activate` starts it.

### Plans

| | Free trial | Build |
| --- | --- | --- |
| Price | $0, one month, no card | $49 per month |
| API credits | 10M, no overage | 80M, then $0.62 per 1M |
| Active Streams | 1 | 10 |
| Destinations per Stream | 1 | 1 |
| Filters, Key-Value Store, logs and receipts, webhook destination | yes | yes |
| Compression, reorg handling, traces | no | yes |

Verified in docs: https://www.quicknode.com/pricing.md

### Arc cost

Arc testnet costs 20 credits per block for `logs`, the same as `block`, `transactions` and `receipts` (40 for `block_with_receipts`).
The legacy billing tier shows 2 per block; new accounts should assume 20.
Verified in docs (calculator data in https://www.quicknode.com/docs/streams/billing).

| Block time | Blocks per day | Credits per day | Free trial lasts | Credits per 30 days |
| --- | --- | --- | --- | --- |
| 0.697 s (measured) | about 124,000 | about 2.5M | about 4 days | about 74M |
| 0.5 s (QuickNode calculator) | 172,800 | about 3.5M | about 2.9 days | about 104M |

A Stream running nonstop exhausts the Free trial in days and roughly fills the Build plan in a month.
Keep it paused outside development and demo windows, start it a day before judging, or move to Build for the event.
A backfill from the Policy deploy block costs 20 credits per block since deployment, so deploy shortly before the first backfill.

## 7. Local development

- Expose the local receiver with a tunnel (`ngrok http 3000`) and use the HTTPS URL plus the route path as the destination URL; webhook.site and typedwebhook.tools are suggested for inspecting raw deliveries.
  Verified in docs: https://www.quicknode.com/docs/streams/destinations/webhooks#exposing-your-local-server
- The dashboard's **Check Connection** button tests reachability before saving.
  Verified in docs (same page).
- `POST /streams/test_filter` with `network`, `dataset`, `filter_function`, `filter_language` and `block` (a string) runs the filter against one real block without creating a Stream and returns `{ "logs": [...console output], "result": "<string>" }`.
  Verified in docs: https://www.quicknode.com/docs/streams/rest-api/test-filter
  Our wrapper: `npm run stream -w @mandate/streams -- test-filter --block <n>`.
- The test-filter and create examples still show a legacy filter shape (`data.streamData.hash`) that contradicts the filters page; follow the filters page (`stream.data`).
  Verified in docs (both pages).
- Without an account, `streams/test/filter.test.ts` runs `filter.js` in a fresh `node:vm` context (no `require`, no `module`) against the recorded Arc testnet batch, and `payload.test.ts` round-trips the filter output through signing, verification and parsing.
- Streams only read `arc-testnet` and `arc-mainnet`, so the local devchain can never feed the Stream path; local end-to-end tests of the ingest route must replay recorded or fixture deliveries.

## 8. Alternatives and fallbacks

None is needed, because Arc testnet is supported.
For completeness:

- **Arc mainnet Stream** (`arc-mainnet`, chain id 5042).
  Supported with the same datasets, but only useful if the Policy contract were deployed on mainnet with real USDC gas.
- **QuickNode Webhooks** (a separate product, also supported on Arc Testnet since September 22, 2026).
  A "contract events" template with no-code filters and 30 credits per delivered payload, which would be far cheaper for our sparse events.
  Verified in docs: https://www.quicknode.com/docs/webhooks and https://www.quicknode.com/pricing.md
  It is not a Stream, so it would not meet the bounty's "at least one Stream" requirement.
  Unverified as a judging question; do not rely on it.
- **Plain RPC.** `https://rpc.quicknode.testnet.arc.io` and `wss://rpc.quicknode.testnet.arc.io` are public, keyless QuickNode endpoints for Arc testnet listed in Arc's docs.
  Verified in docs: https://docs.arc.io/arc/references/rpc-endpoints.md
  Verified live: `eth_chainId` returns `0x4cef52` (5042002), and `eth_getLogs`, `eth_getBlockReceipts` and `eth_getBlockByNumber` work without a key.
  This is the right source for the RPC poller and backfill in #14, but RPC use does not count as Streams usage.

## What is in this repo

| Path | Purpose |
| --- | --- |
| `streams/filter.js` | The filter, uploaded as written apart from the two parameter lines |
| `streams/stream.config.ts` | Create and update request bodies with every fixed choice explained |
| `streams/scripts/quicknode-stream.ts` | `upsert`, `show`, `activate`, `pause`, `delete --yes`, `test-filter --block <n>`, each with `--dry-run` |
| `streams/src/signature.ts` | `verifyQuickNodeSignature` and `computeQuickNodeSignature` |
| `streams/src/payload.ts` | `parseStreamBatch` and `parseStreamPayload`, zod-validated, returning logs in viem's `getLogs` shape |
| `streams/src/filter-source.ts` | Renders and base64-encodes the filter |
| `streams/test/` | Filter, signature and parser tests, and the recorded Arc testnet fixture |

`parseStreamPayload(body)` returns the flat list of logs; `parseStreamBatch(body)` returns the same logs plus the batch range, Stream id and reorged blocks.
Each log is `{ address, topics, data, blockNumber, blockHash, blockTimestamp?, transactionHash, transactionIndex, logIndex, removed }`, with `blockNumber` and `blockTimestamp` as `bigint`, indexes as `number` and hex lowercased.
A test asserts it equals viem's `formatLog` output for the same RPC logs and that the type is interchangeable with viem's `Log<bigint, number, false>`.

## Contradictions with the issues

- **#5** assumed testnet support was in doubt.
  It is supported, so the fallback branch of "Done when" does not apply.
- **#19** expects a Stream "filtered to the Policy contract address, delivered to our webhook"; that works as planned, with three additions.
  The batch size must be at least 5 on Arc, the Free trial's credits last only days of continuous streaming, and the Free plan allows one active Stream and no compression or reorg handling.
- **#19** keeps the RPC poller as a gap-filling fallback.
  Because delivery is sequential and the Stream pauses rather than skips on failure, there are no gaps while it runs; the poller is still needed for the local devchain, for the time before the Stream is activated, and while it is paused to save credits.
  The heartbeat batches tell the console which source is live.
- **#14** keys storage by transaction hash and log index; that is required, not optional, because Streams can re-deliver batches despite its "exactly-once" wording.
- **#14** asks for an intent to reach the browser within two seconds on the local chain.
  That path is the RPC poller; Streams cannot read the devchain, and QuickNode publishes no latency figure for Arc.

## What a person must do

1. Create a QuickNode account on the Free trial at https://www.quicknode.com/signup (no card); accepting the terms is a human step.
2. In the dashboard, open **API Keys**, click **Add API Key**, enable the **Streams** application, choose the **Admin** role, and copy the key into the repo root `.env` as `QUICKNODE_API_KEY`.
   Never paste it into chat or commit it.
3. Generate the webhook secret locally with `openssl rand -hex 32` and put it in `.env` as `QUICKNODE_STREAM_SECURITY_TOKEN`.
   The script sends it as the destination's `security_token`, so QuickNode and the webhook route share it without copying anything back from the dashboard.
   If the Stream is ever created in the dashboard instead, copy the token from the Stream's **Settings** tab into the same variable.
4. Add the remaining values to `.env`:
   - `POLICY_ADDRESS`: the deployed Policy contract on Arc testnet,
   - `QUICKNODE_STREAM_WEBHOOK_URL`: the public HTTPS URL of the webhook route (an ngrok URL during development),
   - optionally `QUICKNODE_STREAM_START_BLOCK` (the Policy deploy block, to backfill history) and `QUICKNODE_STREAM_TOPICS` (comma-separated topic0 values).
5. Check the filter against a block that contains a Policy event: `npm run stream -w @mandate/streams -- test-filter --block <n>`.
6. Create the Stream paused with `npm run stream -w @mandate/streams -- upsert`, start the webhook receiver, then `... -- activate`; use `... -- show` for status and cursor and `... -- pause` whenever nobody is watching, to save credits.
7. Save the first real delivery (headers and raw body) as a fixture and confirm the three open points: whether a filtered body is the bare return value, whether retries are re-signed, and the observed delivery latency.

`.env.example` should list these variables; this branch does not change it because the file was not readable from the agent session that wrote this spike.

## README paragraph for the bounty

> **QuickNode Streams.**
> The console's live feed comes from a QuickNode Stream on **Arc Testnet** (`arc-testnet`, chain id 5042002) using the **Logs** dataset (`logs`), starting at the Policy contract's deploy block so one Stream backfills history and then follows the chain tip.
> A JavaScript **filter** ([`streams/filter.js`](streams/filter.js)) runs on QuickNode's side for every batch of 5 blocks, keeps only the event logs emitted by our Policy contract, and returns them as a compact envelope with the batch's block range.
> The **destination** is a webhook on our dashboard server, which verifies each delivery's `X-QN-Signature` (HMAC-SHA256 over nonce, timestamp and body), rejects stale timestamps, decodes the Policy events, stores them idempotently by transaction hash and log index, and pushes them to the browser over server-sent events.
> The Stream is created and updated by [`streams/scripts/quicknode-stream.ts`](streams/scripts/quicknode-stream.ts) through the Streams REST API, and the full design is in [`docs/quicknode-streams.md`](docs/quicknode-streams.md).
