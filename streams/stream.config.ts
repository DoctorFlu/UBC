/**
 * Create-stream request body for the Mandate Policy Stream.
 * Reference: https://www.quicknode.com/docs/streams/rest-api/create-stream
 * OpenAPI: https://api.quicknode.com/streams/rest/openapi.json
 *
 * Every value here is either fixed by the design (network, dataset, batching) or a
 * placeholder that streams/scripts/quicknode-stream.ts fills from the environment.
 */

/** Values the script fills in. Strings in angle brackets are printed as-is by `--dry-run`. */
export interface StreamInputs {
  /** `arc-testnet` (chain id 5042002) or the fallback `arc-mainnet` (chain id 5042). */
  readonly network: StreamNetwork;
  /** Base64 of the rendered streams/filter.js. */
  readonly filterFunction: string;
  /** Public HTTPS URL of the webhook route. */
  readonly webhookUrl: string;
  /** Shared HMAC secret, at least 32 characters (QUICKNODE_STREAM_SECURITY_TOKEN). */
  readonly securityToken: string;
  /** First block to deliver, normally the Policy deploy block. Omit to start at the chain tip. */
  readonly startBlock?: number | undefined;
}

export type StreamNetwork = "arc-testnet" | "arc-mainnet";

export const STREAM_NETWORKS: readonly StreamNetwork[] = ["arc-testnet", "arc-mainnet"];

/** Stable identifier so a repeated create returns the existing Stream instead of a duplicate. */
export function externalIdFor(network: StreamNetwork): string {
  return `mandate-policy-logs-${network}`;
}

/** Fields that can be changed on an existing Stream with PATCH /streams/{id}. */
export interface StreamUpdateBody {
  name: string;
  filter_function: string;
  filter_language: "javascript";
  dataset_batch_size: number;
  elastic_batch_enabled: boolean;
  fix_block_reorgs: 0 | 1;
  keep_distance_from_tip: number;
  destination: "webhook";
  destination_attributes: {
    url: string;
    compression: "none" | "gzip";
    headers: Record<string, string>;
    max_retry: number;
    retry_interval_sec: number;
    post_timeout_sec: number;
    security_token: string;
  };
}

export interface StreamCreateBody extends StreamUpdateBody {
  network: StreamNetwork;
  dataset: "logs";
  region: "usa_east" | "europe_central" | "asia_east";
  status: "active" | "paused";
  external_id: string;
  start_range?: number;
}

export function buildUpdateBody(inputs: StreamInputs): StreamUpdateBody {
  return {
    name: externalIdFor(inputs.network),
    filter_function: inputs.filterFunction,
    filter_language: "javascript",
    // Arc produces a block every ~0.5 to 0.7 s. Tip Streams on chains with sub-second blocks
    // must use a batch size of at least 5 (422 otherwise), and elastic batching delivers
    // whatever is ready at the tip without waiting for the batch to fill.
    dataset_batch_size: 5,
    elastic_batch_enabled: true,
    // Arc has deterministic finality, and reorg handling is not on the Free plan.
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    destination: "webhook",
    destination_attributes: {
      url: inputs.webhookUrl,
      // Compression is not on the Free plan; the payloads are small after filtering.
      compression: "none",
      headers: {},
      // Streams pauses itself after max_retry failed attempts; these are the documented example values.
      max_retry: 5,
      retry_interval_sec: 2,
      post_timeout_sec: 10,
      security_token: inputs.securityToken,
    },
  };
}

export function buildCreateBody(inputs: StreamInputs): StreamCreateBody {
  const body: StreamCreateBody = {
    ...buildUpdateBody(inputs),
    network: inputs.network,
    dataset: "logs",
    region: "usa_east",
    // Created paused so the configuration can be inspected before any credits are spent.
    status: "paused",
    external_id: externalIdFor(inputs.network),
  };
  if (inputs.startBlock !== undefined) body.start_range = inputs.startBlock;
  return body;
}
