import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpendLedger, utcDay } from "../src/x402/spend-ledger";

const DAY = "2026-11-15";
const AT = new Date("2026-11-15T12:00:00.000Z");
const URL = "http://signals.test/v1/signal/hedge?asset=BTC&horizon=weekly";

function ledgerFile(): string {
  return join(mkdtempSync(join(tmpdir(), "mandate-ledger-")), "nested", "signal-spend.jsonl");
}

const reserve = (ledger: SpendLedger, amount: bigint, budget = 2_000n, day = DAY) =>
  ledger.reserve({ amount, budget, day, url: URL, at: AT });

describe("SpendLedger", () => {
  it("reserves within the budget and refuses what would go over it, without writing", () => {
    const file = ledgerFile();
    const ledger = SpendLedger.open(file);
    expect(reserve(ledger, 1_000n)).toMatchObject({ ok: true, spentBefore: 0n });
    expect(reserve(ledger, 1_000n)).toMatchObject({ ok: true, spentBefore: 1_000n });
    const linesBefore = readFileSync(file, "utf8");
    expect(reserve(ledger, 1n)).toEqual({ ok: false, spent: 2_000n });
    expect(readFileSync(file, "utf8")).toBe(linesBefore);
    expect(ledger.spentOn(DAY)).toBe(2_000n);
  });

  it("counts paid amounts, frees released ones, and refuses to settle a reservation twice", () => {
    const ledger = SpendLedger.open(ledgerFile());
    const first = reserve(ledger, 1_000n);
    const second = reserve(ledger, 500n);
    if (!first.ok || !second.ok) throw new Error("expected reservations");
    ledger.markPaid(first.id, { amount: 900n, nonce: "0xabc", at: AT });
    ledger.release(second.id, "rejected: insufficient_balance", AT);
    expect(ledger.spentOn(DAY)).toBe(900n);
    expect(ledger.entriesOn(DAY).map((e) => [e.status, e.amount, e.nonce])).toEqual([
      ["paid", 900n, "0xabc"],
      ["released", 500n, null],
    ]);
    expect(() => {
      ledger.release(first.id, "late", AT);
    }).toThrow(/No open reservation/);
    expect(() => {
      ledger.markPaid(second.id, { amount: 1n, nonce: "0x1", at: AT });
    }).toThrow();
    expect(() => reserve(ledger, 0n)).toThrow(RangeError);
  });

  it("survives a restart, keeping unsettled reservations counted against the budget", () => {
    const file = ledgerFile();
    const before = SpendLedger.open(file);
    const paid = reserve(before, 1_000n);
    const released = reserve(before, 300n);
    reserve(before, 200n); // the process stops mid-payment: neither paid nor released
    if (!paid.ok || !released.ok) throw new Error("expected reservations");
    before.markPaid(paid.id, { amount: 1_000n, nonce: "0xdef", at: AT });
    before.release(released.id, "not_sent", AT);

    const after = SpendLedger.open(file);
    expect(after.skippedLines).toBe(0);
    expect(after.spentOn(DAY)).toBe(1_200n);
    expect(reserve(after, 900n)).toMatchObject({ ok: false, spent: 1_200n });
    expect(reserve(after, 800n)).toMatchObject({ ok: true });
  });

  it("starts each UTC day with the full budget", () => {
    const ledger = SpendLedger.open(ledgerFile());
    expect(reserve(ledger, 2_000n, 2_000n, DAY).ok).toBe(true);
    expect(reserve(ledger, 1n, 2_000n, DAY).ok).toBe(false);
    expect(reserve(ledger, 2_000n, 2_000n, "2026-11-16").ok).toBe(true);
    expect(utcDay(new Date("2026-11-15T23:59:59.999Z"))).toBe(DAY);
    expect(utcDay(new Date("2026-11-16T00:00:00.000Z"))).toBe("2026-11-16");
  });

  it("skips a line torn by a crash and keeps appending on a fresh line", () => {
    const file = ledgerFile();
    const ledger = SpendLedger.open(file);
    reserve(ledger, 700n);
    appendFileSync(file, '{"type":"reserve","id":"torn","day":"2026-11-15","amo');

    const reopened = SpendLedger.open(file);
    expect(reopened.skippedLines).toBe(1);
    expect(reopened.spentOn(DAY)).toBe(700n);
    reserve(reopened, 100n);

    const again = SpendLedger.open(file);
    expect(again.skippedLines).toBe(1);
    expect(again.spentOn(DAY)).toBe(800n);
  });

  it("keeps its file private to the owner", () => {
    const file = ledgerFile();
    reserve(SpendLedger.open(file), 1n);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
