/**
 * Durable record of what the signal tool spent, so the daily budget survives a restart.
 *
 * It is an append-only JSON-lines file. Each payment goes through three steps:
 *
 * 1. `reserve` the price before anything is signed. The check against the budget and the write
 *    happen in one synchronous step, so two calls running at once cannot both squeeze under the limit.
 * 2. `markPaid` with the amount actually paid once the seller has served the signal, or
 * 3. `release` when nothing was charged (the price was refused before signing, or Gateway rejected
 *    the payment).
 *
 * A reservation that was neither paid nor released (the process stopped mid-payment, or the outcome
 * is unknown) keeps counting against the budget: the ledger errs towards spending less.
 * One server process owns the file; it is not safe for two processes to append to it at once.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import * as z from "zod";

const baseUnits = z.string().regex(/^\d+$/);
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reserve"),
    id: z.string().min(1),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: baseUnits,
    url: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("paid"),
    id: z.string().min(1),
    amount: baseUnits,
    nonce: z.string(),
    at: z.string(),
  }),
  z.object({ type: z.literal("release"), id: z.string().min(1), reason: z.string(), at: z.string() }),
]);
type LedgerEvent = z.infer<typeof eventSchema>;

export type SpendStatus = "reserved" | "paid" | "released";

export interface SpendEntry {
  id: string;
  /** UTC day the spend counts against, `YYYY-MM-DD`. */
  day: string;
  /** USDC base units: the reservation until paid, then the amount paid. */
  amount: bigint;
  status: SpendStatus;
  url: string;
  nonce: string | null;
  reservedAt: string;
}

export type ReserveResult = { ok: true; id: string; spentBefore: bigint } | { ok: false; spent: bigint };

/** UTC calendar day of an instant, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export class SpendLedger {
  private readonly entries = new Map<string, SpendEntry>();
  /** Lines that could not be read at startup (a write torn by a crash). */
  readonly skippedLines: number;

  private constructor(
    private readonly file: string,
    events: readonly LedgerEvent[],
    skippedLines: number,
  ) {
    for (const event of events) this.apply(event);
    this.skippedLines = skippedLines;
  }

  /** Opens the ledger at `file`, creating its directory (mode 700) and reading what is there. */
  static open(file: string): SpendLedger {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) return new SpendLedger(file, [], 0);
    const text = readFileSync(file, "utf8");
    const events: LedgerEvent[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(eventSchema.parse(JSON.parse(line)));
      } catch {
        skipped += 1;
      }
    }
    const ledger = new SpendLedger(file, events, skipped);
    // A crash mid-write can leave a last line without its newline; start the next event on a new line.
    if (text !== "" && !text.endsWith("\n")) ledger.write("\n");
    return ledger;
  }

  /** Reserved and paid amounts on `day`, in base units. */
  spentOn(day: string): bigint {
    let total = 0n;
    for (const entry of this.entries.values()) {
      if (entry.day === day && entry.status !== "released") total += entry.amount;
    }
    return total;
  }

  entriesOn(day: string): SpendEntry[] {
    return [...this.entries.values()].filter((entry) => entry.day === day);
  }

  /** Reserves `amount` against `budget` for `day`, or refuses without writing anything. */
  reserve(input: { amount: bigint; budget: bigint; day: string; url: string; at: Date }): ReserveResult {
    if (input.amount <= 0n) throw new RangeError("a reservation must be positive");
    const spent = this.spentOn(input.day);
    if (spent + input.amount > input.budget) return { ok: false, spent };
    const id = randomUUID();
    this.append({
      type: "reserve",
      id,
      day: input.day,
      amount: input.amount.toString(),
      url: input.url,
      at: input.at.toISOString(),
    });
    return { ok: true, id, spentBefore: spent };
  }

  markPaid(id: string, paid: { amount: bigint; nonce: string; at: Date }): void {
    this.requireReserved(id);
    this.append({
      type: "paid",
      id,
      amount: paid.amount.toString(),
      nonce: paid.nonce,
      at: paid.at.toISOString(),
    });
  }

  release(id: string, reason: string, at: Date): void {
    this.requireReserved(id);
    this.append({ type: "release", id, reason, at: at.toISOString() });
  }

  private requireReserved(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.status !== "reserved") throw new Error(`No open reservation ${id}`);
  }

  private append(event: LedgerEvent): void {
    // Write and fsync before the in-memory state changes, so memory never claims more than the disk.
    this.write(`${JSON.stringify(event)}\n`);
    this.apply(event);
  }

  private write(text: string): void {
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private apply(event: LedgerEvent): void {
    if (event.type === "reserve") {
      this.entries.set(event.id, {
        id: event.id,
        day: event.day,
        amount: BigInt(event.amount),
        status: "reserved",
        url: event.url,
        nonce: null,
        reservedAt: event.at,
      });
      return;
    }
    const entry = this.entries.get(event.id);
    if (entry === undefined) return;
    if (event.type === "paid") {
      entry.status = "paid";
      entry.amount = BigInt(event.amount);
      entry.nonce = event.nonce;
    } else {
      entry.status = "released";
    }
  }
}
