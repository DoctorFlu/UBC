import { describe, expect, it } from "vitest";
import type { PolicyEvent } from "@mandate/shared";
import { EventIndex } from "../src/chain/event-index";

const proposed = (intentId: number, blockNumber: number): PolicyEvent => ({
  type: "IntentNeedsApproval",
  intentId,
  amountCents: 2_100,
  blockNumber,
  blockTimestamp: 1_000 + blockNumber,
  transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
  logIndex: 0,
});

/** A chain whose head the test moves, and whose log scans wait until the test releases them. */
function fakeChain() {
  const waiting: (() => void)[] = [];
  const chain = {
    head: 10n,
    events: [] as PolicyEvent[],
    scans: 0,
    /** Lets every scan waiting so far finish. */
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
    client: {
      publicClient: { getBlockNumber: () => Promise.resolve(chain.head) },
      getEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        chain.scans += 1;
        await new Promise<void>((resolve) => waiting.push(resolve));
        return chain.events.filter(
          (e) => BigInt(e.blockNumber) >= fromBlock && BigInt(e.blockNumber) <= toBlock,
        );
      },
    },
  };
  return chain;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EventIndex", () => {
  it("answers as of the block that was latest when the call started, even when it joins an older scan", async () => {
    const chain = fakeChain();
    const index = new EventIndex(chain.client as never, 0n);
    // A scan up to block 10 starts and waits.
    const early = index.intents();
    await tick();
    expect(chain.scans).toBe(1);
    // Meanwhile an intent lands in block 11, and a second reader asks while that scan is in flight.
    chain.head = 11n;
    chain.events.push(proposed(0, 11));
    const late = index.intents();
    await tick();
    chain.release();
    expect([...(await early).keys()]).toEqual([]);
    // The second reader does not stop at the older scan: it scans again, up to block 11.
    await tick();
    expect(chain.scans).toBe(2);
    chain.release();
    expect([...(await late).keys()]).toEqual([0]);
  });
});
