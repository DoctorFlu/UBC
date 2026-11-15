import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { bytes32Schema } from "./types";

/**
 * Decision context: the record of why the agent proposed an intent. The agent stores the document
 * offchain and puts `hashContext(doc)` onchain as the intent's `contextHash`, so anyone holding the
 * document can prove it was not rewritten later.
 *
 * Every number in the document is an integer (prices in cents), so the canonical JSON is identical in any
 * language. Unknown keys are rejected, because a field the schema drops would not be covered by the hash.
 */

const isoDateTime = z.iso.datetime({ offset: true });
const nullableCents = z.int().nonnegative().nullable();

export const ladderRungSchema = z.strictObject({
  /** Gemini `instrumentSymbol` of the rung. */
  instrumentSymbol: z.string().min(1),
  /** Human label, for example "BTC above $65,000". */
  label: z.string(),
  /** Best YES bid and ask in cents per contract, or null when the book side was empty. */
  yesBidCents: nullableCents,
  yesAskCents: nullableCents,
});

export const ladderSummarySchema = z.strictObject({
  /** Gemini event ticker the rungs belong to. */
  eventTicker: z.string().min(1),
  /** When the agent looked at the book. */
  observedAt: isoDateTime,
  rungs: z.array(ladderRungSchema),
});

export const decisionContextSchema = z.strictObject({
  version: z.literal(1),
  /** The owner's request, in their words. */
  requestText: z.string(),
  /** Planner plan the intent belongs to. */
  planId: z.string().min(1),
  /** Index of the ladder rung this intent trades. */
  rungIndex: z.int().nonnegative(),
  ladderSummary: ladderSummarySchema,
  /** Receipts of paid signals the agent used. */
  signalReceiptIds: z.array(z.string().min(1)),
  /** The agent's stated reason for this intent. */
  reason: z.string().min(1),
  createdAt: isoDateTime,
});

export type LadderRung = z.infer<typeof ladderRungSchema>;
export type LadderSummary = z.infer<typeof ladderSummarySchema>;
export type DecisionContext = z.infer<typeof decisionContextSchema>;

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order at every level, no whitespace, array
 * order kept. Rejects values JSON cannot represent exactly (undefined, functions, bigint, NaN, Infinity).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`${path}: only plain objects are allowed`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} cannot be serialized`);
  }
}

/** Validates the document and returns keccak256 of its canonical JSON (UTF-8). */
export function hashContext(doc: DecisionContext): Hex {
  const valid = decisionContextSchema.parse(doc);
  return keccak256(stringToBytes(canonicalJson(valid)));
}

/** True when `doc` is a valid decision context whose hash equals `hash`. Never throws. */
export function verifyContext(doc: unknown, hash: string): boolean {
  const parsedDoc = decisionContextSchema.safeParse(doc);
  const parsedHash = bytes32Schema.safeParse(hash);
  if (!parsedDoc.success || !parsedHash.success) return false;
  return hashContext(parsedDoc.data).toLowerCase() === parsedHash.data.toLowerCase();
}
