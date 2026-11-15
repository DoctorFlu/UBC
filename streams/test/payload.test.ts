import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { formatLog, type Log, type RpcLog } from "viem";
import { describe, expect, expectTypeOf, it } from "vitest";

import { readFilterTemplate, renderFilter } from "../src/filter-source";
import { type ArcLog, StreamPayloadError, parseStreamBatch, parseStreamPayload } from "../src/payload";
import { computeQuickNodeSignature, verifyQuickNodeSignature } from "../src/signature";

const FIXTURE_TEXT = readFileSync(
  new URL("./fixtures/arc-testnet-logs-dataset.json", import.meta.url),
  "utf8",
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as { data: unknown[]; metadata: Record<string, unknown> };
const RAW_LOGS = FIXTURE.data.flat(2) as RpcLog[];
const CONTRACT = "0x1290b4f2a419a316467b580a088453a233e9adcc";

function filterBody(): string {
  const source = renderFilter(readFilterTemplate(), { addresses: [CONTRACT] });
  const main = runInNewContext(`${source}\n;main`, {}) as (input: unknown) => unknown;
  return JSON.stringify(main(FIXTURE));
}

describe("ArcLog", () => {
  it("is interchangeable with viem's Log for a mined block", () => {
    expectTypeOf<ArcLog>().toExtend<Log<bigint, number, false>>();
    expectTypeOf<Log<bigint, number, false>>().toExtend<ArcLog>();
  });
});

describe("parseStreamBatch on the unfiltered logs dataset", () => {
  const batch = parseStreamBatch(FIXTURE);

  it("flattens every log in the batch, skipping receipts without logs", () => {
    expect(batch.source).toBe("dataset");
    expect(batch.logs).toHaveLength(39);
  });

  it("reads the batch metadata", () => {
    expect(batch.batch).toEqual({
      network: "arc-testnet",
      streamId: "f6ad6459-b5ad-4183-b370-1c1388e47e83",
      startBlock: 72471363n,
      endBlock: 72471367n,
      blocksReorged: [],
    });
  });

  it("orders logs by block, then log index", () => {
    const positions = batch.logs.map((log) => [log.blockNumber, log.logIndex] as const);
    const sorted = [...positions].sort(([b1, i1], [b2, i2]) => (b1 === b2 ? i1 - i2 : b1 < b2 ? -1 : 1));
    expect(positions).toEqual(sorted);
  });

  it("produces exactly what viem's formatLog produces from the same RPC logs", () => {
    const viaViem = RAW_LOGS.map((log) => formatLog(log));
    expect(batch.logs).toEqual(viaViem);
  });
});

describe("parseStreamBatch on the filter envelope", () => {
  it("round-trips filter output through signing, verification and parsing", () => {
    const body = filterBody();
    const nonce = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const timestamp = "1763210000";
    const headers = {
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": computeQuickNodeSignature("t".repeat(32), nonce, timestamp, body),
    };
    const verified = verifyQuickNodeSignature(headers, body, "t".repeat(32), { now: () => 1763210000_000 });
    expect(verified.ok).toBe(true);

    const batch = parseStreamBatch(JSON.parse(body));
    expect(batch.source).toBe("filter");
    expect(batch.batch.endBlock).toBe(72471367n);
    expect(batch.logs).toEqual(
      RAW_LOGS.filter((log) => log.address === CONTRACT).map((log) => formatLog(log)),
    );
    expect(batch.logs[0]).toEqual({
      address: CONTRACT,
      topics: [
        "0x46f6fe577ecfefe55b0f14f0b42ddb4c22db1fb9bade43aa02c5ef4e5439512e",
        "0x000000000000000000000000bf9d607fe726b9baa30facc6d6cfec03ec89b700",
      ],
      data: "0x000000000000000000000000000000000000000000000000000000000000001f",
      blockNumber: 72471365n,
      blockHash: "0x906b3c8c292ac684268399e6f112e97d863f1d6bc1291caf11463fec49389f64",
      blockTimestamp: 1794773455n,
      transactionHash: "0x258143b9873eebe0e50ca950d6c2b95e3fde1cd0dc89aa6b820bca8080be07e1",
      transactionIndex: 1,
      logIndex: 4,
      removed: false,
    });
  });

  it("accepts an empty heartbeat batch", () => {
    const body = {
      schema: "mandate.quicknode.policy-logs/v1",
      batch_start_range: 1,
      batch_end_range: 5,
      logs: [],
    };
    expect(parseStreamPayload(body)).toEqual([]);
    expect(parseStreamBatch(body).batch).toMatchObject({ startBlock: 1n, endBlock: 5n, network: null });
  });

  it("unwraps the envelope if QuickNode nests the filter output under data", () => {
    const envelope = JSON.parse(filterBody()) as unknown;
    const metadata = { network: "arc-testnet", dataset: "logs" };
    for (const body of [
      { data: envelope, metadata },
      { data: [envelope], metadata },
    ]) {
      const batch = parseStreamBatch(body);
      expect(batch.source).toBe("filter");
      expect(batch.logs).toHaveLength(6);
    }
  });

  it("normalizes case and omits blockTimestamp when the source has none", () => {
    const [log] = parseStreamPayload({
      schema: "mandate.quicknode.policy-logs/v1",
      logs: [
        {
          address: "0x1290B4F2A419A316467B580A088453A233E9ADCC",
          topics: [`0x${"AB".repeat(32)}`],
          data: "0xDEADBEEF",
          blockNumber: "0x10",
          blockHash: `0x${"CD".repeat(32)}`,
          transactionHash: `0x${"EF".repeat(32)}`,
          transactionIndex: "0x0",
          logIndex: "0x0",
        },
      ],
    });
    expect(log).toEqual({
      address: CONTRACT,
      topics: [`0x${"ab".repeat(32)}`],
      data: "0xdeadbeef",
      blockNumber: 16n,
      blockHash: `0x${"cd".repeat(32)}`,
      transactionHash: `0x${"ef".repeat(32)}`,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    });
    expect(log).not.toHaveProperty("blockTimestamp");
  });
});

describe("parseStreamBatch rejects", () => {
  it("a malformed log with a readable error", () => {
    const body = {
      schema: "mandate.quicknode.policy-logs/v1",
      logs: [{ address: "0x12", topics: [], data: "0x" }],
    };
    expect(() => parseStreamBatch(body)).toThrow(StreamPayloadError);
    expect(() => parseStreamBatch(body)).toThrow(/address/);
  });

  it("an unknown envelope schema version", () => {
    expect(() => parseStreamBatch({ schema: "mandate.quicknode.policy-logs/v2", logs: [] })).toThrow(
      StreamPayloadError,
    );
  });

  it("a payload from another dataset", () => {
    expect(() => parseStreamBatch({ data: [], metadata: { dataset: "block" } })).toThrow(/logs dataset/);
  });

  it("bodies that are not Streams payloads", () => {
    for (const body of [null, "x", [], {}, { data: "x", metadata: {} }]) {
      expect(() => parseStreamBatch(body)).toThrow(StreamPayloadError);
    }
  });

  it("more than four topics", () => {
    const log = { ...RAW_LOGS[0], topics: Array.from({ length: 5 }, () => `0x${"00".repeat(32)}`) };
    expect(() => parseStreamPayload({ schema: "mandate.quicknode.policy-logs/v1", logs: [log] })).toThrow(
      /topics/,
    );
  });
});
