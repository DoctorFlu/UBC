import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { FILTER_SCHEMA } from "../src/payload";
import { encodeFilter, readFilterTemplate, renderFilter } from "../src/filter-source";

// Recorded Arc testnet logs (blocks 72471363 to 72471367) in the documented logs dataset envelope.
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/arc-testnet-logs-dataset.json", import.meta.url), "utf8"),
) as { data: unknown[]; metadata: Record<string, unknown> };

// A contract with 6 logs in the fixture, standing in for the Policy contract.
const CONTRACT = "0x1290b4f2a419a316467b580a088453a233e9adcc";
const TOPIC_A = "0x46f6fe577ecfefe55b0f14f0b42ddb4c22db1fb9bade43aa02c5ef4e5439512e";

interface RawLog {
  address: string;
  topics: string[];
  logIndex: string;
  blockNumber: string;
}

/**
 * Runs the filter the way QuickNode does: a script in a fresh context with no require, import or
 * module, whose `main` receives `{ data, metadata }`. The result is JSON round-tripped, as delivery does.
 */
function runFilter(source: string, stream: unknown): unknown {
  const main = runInNewContext(`${source}\n;main`, { console }) as (input: unknown) => unknown;
  return JSON.parse(JSON.stringify(main(stream))) as unknown;
}

const rawLogs = FIXTURE.data.flat(2) as RawLog[];

describe("filter.js", () => {
  const template = readFilterTemplate();

  it("uses nothing the QuickNode sandbox forbids", () => {
    expect(template).not.toMatch(
      /\brequire\s*\(|^\s*import\s|\bexport\s|\beval\s*\(|\bFunction\s*\(|\bfetch\s*\(/m,
    );
    expect(template).toMatch(/^function main\(stream\) \{$/m);
  });

  it("keeps nothing until a Policy address is rendered in (fail closed)", () => {
    const result = runFilter(template, FIXTURE) as { logs: unknown[] };
    expect(result.logs).toEqual([]);
  });

  it("keeps only the configured contract's logs and echoes the batch metadata", () => {
    const source = renderFilter(template, { addresses: [CONTRACT] });
    const result = runFilter(source, FIXTURE);
    const expected = rawLogs.filter((log) => log.address === CONTRACT);
    expect(expected).toHaveLength(6);
    expect(result).toEqual({
      schema: FILTER_SCHEMA,
      network: "arc-testnet",
      stream_id: FIXTURE.metadata.stream_id,
      batch_start_range: 72471363,
      batch_end_range: 72471367,
      blocks_reorged: null,
      logs: expected,
    });
  });

  it("applies the topic0 allowlist", () => {
    const source = renderFilter(template, { addresses: [CONTRACT], topics: [TOPIC_A] });
    const result = runFilter(source, FIXTURE) as { logs: RawLog[] };
    expect(result.logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      ["0x451d345", "0x4"],
      ["0x451d347", "0x2"],
    ]);
  });

  it("matches addresses case-insensitively and accepts several contracts", () => {
    const other = "0x71eae448a053b15e12d2542b5f9d5d72d39c5593";
    const source = renderFilter(template, {
      addresses: [CONTRACT.toUpperCase().replace("0X", "0x"), other],
    });
    const result = runFilter(source, FIXTURE) as { logs: RawLog[] };
    expect(result.logs).toHaveLength(10);
  });

  it("still delivers an empty batch as a heartbeat", () => {
    const source = renderFilter(template, { addresses: [`0x${"ab".repeat(20)}`] });
    expect(runFilter(source, FIXTURE)).toMatchObject({ batch_end_range: 72471367, logs: [] });
  });

  it("tolerates any nesting depth of stream.data", () => {
    const source = renderFilter(template, { addresses: [CONTRACT] });
    const flat = { ...FIXTURE, data: rawLogs };
    expect((runFilter(source, flat) as { logs: unknown[] }).logs).toHaveLength(6);
  });

  it("rejects bad parameters before anything is uploaded", () => {
    expect(() => renderFilter(template, { addresses: [] })).toThrow(/At least one/);
    expect(() => renderFilter(template, { addresses: ["0x1234"] })).toThrow(/20-byte/);
    expect(() => renderFilter(template, { addresses: [CONTRACT], topics: ["0x01"] })).toThrow(/32-byte/);
    expect(() => renderFilter("function main() {}", { addresses: [CONTRACT] })).toThrow(/exactly one line/);
  });

  it("encodes the source as base64 for filter_function", () => {
    const source = renderFilter(template, { addresses: [CONTRACT] });
    expect(Buffer.from(encodeFilter(source), "base64").toString("utf8")).toBe(source);
  });
});
