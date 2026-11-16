import { describe, expect, it } from "vitest";

import { fixtureSnapshot } from "@/fixtures";

import { auditRows, blockedByRule, toCsv, toJson, visibleRows } from "./audit-rows";

const chain = fixtureSnapshot.chain;
if (!chain) throw new Error("the fixture snapshot has a chain");
const rows = auditRows(chain);

describe("audit rows", () => {
  it("has one row per ingested event, in chain order, each with its block, time and transaction", () => {
    expect(rows).toHaveLength(chain.events.length);
    rows.forEach((row, index) => {
      const event = chain.events[index];
      expect(row.event).toBe(event?.type);
      expect(row.blockNumber).toBe(event?.blockNumber);
      expect(row.blockTimestamp).toBe(event?.blockTimestamp);
      expect(row.txHash).toBe(event?.transactionHash);
      expect(row.at).toBe(new Date((event?.blockTimestamp ?? 0) * 1000).toISOString());
    });
  });

  it("tells the owner's decision on a held intent from the contract's verdict at proposal", () => {
    const intent3 = rows.filter((row) => row.intentId === 3);
    expect(intent3.map((row) => [row.label, row.group])).toEqual([
      ["Intent proposed", "verdict"],
      ["Held for approval", "verdict"],
      ["Rejected by owner", "owner"],
    ]);
    const intent4 = rows.filter((row) => row.intentId === 4).at(-1);
    expect(intent4).toMatchObject({
      label: "Intent rejected",
      group: "verdict",
      reason: "over max trade size",
    });
  });

  it("numbers mandate versions and names the kill switch", () => {
    expect(rows[0]).toMatchObject({ label: "Mandate set", group: "mandate" });
    expect(rows[1]).toMatchObject({ label: "Resumed", group: "pause" });
  });

  it("filters by kind and orders either way", () => {
    const results = visibleRows(rows, "result", "oldest");
    expect(results.every((row) => row.group === "result")).toBe(true);
    expect(results.map((row) => row.intentId)).toEqual([0, 1, 2]);
    expect(visibleRows(rows, "result", "newest").map((row) => row.intentId)).toEqual([2, 1, 0]);
    expect(visibleRows(rows, "all", "newest")[0]).toEqual(rows.at(-1));
  });

  it("counts rejections by the contract's reason", () => {
    expect(blockedByRule(rows)).toEqual([
      ["category not allowed", 1],
      ["over max trade size", 1],
      ["rejected by user", 1],
    ]);
  });

  it("exports exactly the rows given, in that order, as CSV and JSON", () => {
    const shown = visibleRows(rows, "verdict", "newest");
    const csv = toCsv(shown, "https://explorer.test");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "time_utc,block_timestamp,block,log_index,event,label,intent,status,reason,summary,tx_hash,explorer_url",
    );
    expect(lines).toHaveLength(shown.length + 1);
    expect(lines[1]).toContain(shown[0]?.txHash);
    expect(lines[1]).toContain(`https://explorer.test/tx/${shown[0]?.txHash ?? ""}`);

    const json = JSON.parse(
      toJson(shown, null, {
        contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        chainId: 5042002,
        network: "Local dev chain",
        filter: "verdict",
        order: "newest",
        exportedAt: "2026-11-15T14:00:00.000Z",
      }),
    ) as { rows: { tx_hash: string; block: number; explorer_url: string | null }[]; filter: string };
    expect(json.filter).toBe("verdict");
    expect(json.rows.map((row) => row.tx_hash)).toEqual(shown.map((row) => row.txHash));
    expect(json.rows.map((row) => row.block)).toEqual(shown.map((row) => row.blockNumber));
    expect(json.rows.every((row) => row.explorer_url === null)).toBe(true);
  });

  it("quotes CSV cells that hold a comma, a quote or a line break", () => {
    const first = rows[0];
    if (!first) throw new Error("no rows");
    const csv = toCsv([{ ...first, summary: 'a "quoted", summary\nwith a break' }], null);
    expect(csv).toContain('"a ""quoted"", summary\nwith a break"');
  });
});
