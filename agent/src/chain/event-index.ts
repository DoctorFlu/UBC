import {
  emptyPolicyViewState,
  reduceEvents,
  type IntentView,
  type PolicyClient,
  type PolicyViewState,
} from "@mandate/shared";

/**
 * How far back to scan when the deploy block is unknown. On Arc testnet this is about a day of
 * blocks; set POLICY_DEPLOY_BLOCK to scan the full history instead.
 */
export const DEFAULT_LOOKBACK_BLOCKS = 200_000n;
const MAX_SYNC_ROUNDS = 5;

/**
 * Policy events kept by the long-lived server process and caught up incrementally, so each tool
 * call scans only the blocks since the last one. Rejection reasons live only in events (the
 * contract does not store them), which is why the agent needs this at all.
 */
export class EventIndex {
  readonly #client: Pick<PolicyClient, "getEvents" | "publicClient">;
  readonly #deployBlock: bigint | undefined;
  #state: PolicyViewState = emptyPolicyViewState();
  #nextBlock: bigint | undefined;
  #syncing: Promise<void> | undefined;

  constructor(client: Pick<PolicyClient, "getEvents" | "publicClient">, deployBlock?: bigint) {
    this.#client = client;
    this.#deployBlock = deployBlock;
  }

  /**
   * Intents seen in the scanned blocks, by id, up to at least the block that was latest when this call
   * started. A transaction confirmed before the call is therefore always in the answer, even when the
   * call joins a scan that another caller started earlier.
   */
  async intents(): Promise<ReadonlyMap<number, IntentView>> {
    const latest = await this.#latest();
    // A node behind a load balancer can answer with an older block; a few rounds catch up with it.
    for (let round = 0; this.#nextBlock === undefined || this.#nextBlock <= latest; round++) {
      if (round === MAX_SYNC_ROUNDS)
        throw new Error(`The chain node did not reach block ${latest.toString()}`);
      await this.sync();
    }
    return new Map(Object.values(this.#state.intents).map((intent) => [intent.id, intent]));
  }

  /** Catches up to the latest block. Concurrent callers share one scan. */
  sync(): Promise<void> {
    this.#syncing ??= this.#catchUp().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  #latest(): Promise<bigint> {
    return this.#client.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  async #catchUp(): Promise<void> {
    const latest = await this.#latest();
    const from =
      this.#nextBlock ??
      this.#deployBlock ??
      (latest > DEFAULT_LOOKBACK_BLOCKS ? latest - DEFAULT_LOOKBACK_BLOCKS : 0n);
    if (from > latest) return;
    const events = await this.#client.getEvents({ fromBlock: from, toBlock: latest });
    if (events.length > 0) this.#state = reduceEvents([...this.#state.events, ...events]);
    this.#nextBlock = latest + 1n;
  }
}
