import "server-only";

import { type PolicyEvent, decodePolicyLogs, toSafeNumber } from "@mandate/shared";
import type { Address, Chain, Log, PublicClient, Transport } from "viem";

export type ChainClient = PublicClient<Transport, Chain>;

/**
 * Reads Policy logs in block ranges the RPC accepts. Public RPCs cap `eth_getLogs` ranges at different
 * sizes and say so only in an error, so the range halves on every failure (down to `minRange`) and
 * grows back slowly after successes.
 */
export class LogScanner {
  private range: bigint;

  constructor(
    private readonly client: ChainClient,
    private readonly address: Address,
    private readonly options: { maxRange: bigint; minRange: bigint } = { maxRange: 5_000n, minRange: 50n },
  ) {
    this.range = options.maxRange;
  }

  /** The next chunk to read, starting at `from` and never past `latest`. */
  nextChunk(from: bigint, latest: bigint): { from: bigint; to: bigint } {
    const to = from + this.range - 1n;
    return { from, to: to < latest ? to : latest };
  }

  /** Reads and decodes one chunk. On failure the next chunk is smaller; the error is rethrown. */
  async read(chunk: { from: bigint; to: bigint }): Promise<PolicyEvent[]> {
    let logs: Log[];
    try {
      logs = await this.client.getLogs({ address: this.address, fromBlock: chunk.from, toBlock: chunk.to });
    } catch (error) {
      const half = this.range / 2n;
      this.range = half > this.options.minRange ? half : this.options.minRange;
      throw error;
    }
    const grown = this.range * 2n;
    this.range = grown < this.options.maxRange ? grown : this.options.maxRange;
    return decodePolicyLogs(logs, {
      address: this.address,
      blockTimestamps: await blockTimestamps(this.client, logs),
    });
  }
}

/** Unix seconds of every block a log without `blockTimestamp` came from (one batched request). */
export async function blockTimestamps(
  client: ChainClient,
  logs: readonly Pick<Log, "blockNumber" | "blockTimestamp">[],
): Promise<Map<bigint, number>> {
  const missing = new Set<bigint>();
  for (const log of logs) {
    if (log.blockTimestamp == null && log.blockNumber !== null) missing.add(log.blockNumber);
  }
  const entries = await Promise.all(
    [...missing].map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      return [blockNumber, toSafeNumber(block.timestamp, "timestamp")] as const;
    }),
  );
  return new Map(entries);
}

/**
 * The block the contract was deployed in, found by binary search on `eth_getCode` (about 25 reads on
 * Arc testnet). Used only when `POLICY_DEPLOY_BLOCK` is not set.
 */
export async function findDeployBlock(
  client: ChainClient,
  address: Address,
  latest: bigint,
): Promise<bigint> {
  const deployedAt = async (block: bigint) => {
    const code = await client.getCode({ address, blockNumber: block });
    return code !== undefined && code !== "0x";
  };
  if (!(await deployedAt(latest))) {
    throw new Error(`No contract code at ${address} on this chain`);
  }
  let low = 0n;
  let high = latest;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (await deployedAt(mid)) high = mid;
    else low = mid + 1n;
  }
  return low;
}
