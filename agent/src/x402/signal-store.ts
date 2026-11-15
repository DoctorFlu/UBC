/**
 * Purchased signals, one JSON file per receipt, so a later tool call (for example `plan_hedge` in a
 * fresh MCP session) can use a signal by its receipt id alone.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hedgeSignalSchema, verifyHedgeSignal } from "@mandate/shared";
import * as z from "zod";

/** A receipt id is the 32-byte nonce of the payment authorization, as Gateway's transfer history keys it. */
export const receiptIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, {
  message: "must be a receipt id: 0x and 64 hex digits",
});

const purchaseSchema = z.object({
  receiptId: receiptIdSchema,
  signal: hedgeSignalSchema,
  receipt: z.object({
    url: z.string(),
    amount: z.string().regex(/^\d+$/),
    amountUsdc: z.string(),
    payer: z.string(),
    payee: z.string(),
    network: z.string(),
    settlementId: z.string().nullable(),
    paidAt: z.string(),
  }),
});

export type SignalPurchase = z.infer<typeof purchaseSchema>;

export class SignalStore {
  private constructor(private readonly dir: string) {}

  /** Opens the store at `dir`, creating it with mode 700. */
  static open(dir: string): SignalStore {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new SignalStore(dir);
  }

  /** Writes the purchase atomically (temporary file, then rename). */
  save(purchase: SignalPurchase): void {
    const valid = purchaseSchema.parse(purchase);
    const target = this.pathFor(valid.receiptId);
    const temp = join(this.dir, `.${randomUUID()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  }

  /** The purchase for a receipt id, or undefined when there is none or it fails validation. */
  load(receiptId: string): SignalPurchase | undefined {
    if (!receiptIdSchema.safeParse(receiptId).success) return undefined;
    const file = this.pathFor(receiptId);
    if (!existsSync(file)) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    const parsed = purchaseSchema.safeParse(json);
    if (!parsed.success || !verifyHedgeSignal(parsed.data.signal)) return undefined;
    return parsed.data;
  }

  private pathFor(receiptId: string): string {
    return join(this.dir, `${receiptId.toLowerCase()}.json`);
  }
}
