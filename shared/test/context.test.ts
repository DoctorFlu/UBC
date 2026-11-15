import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { canonicalJson, CanonicalJsonError, hashContext, verifyContext, type DecisionContext } from "../src";

const doc: DecisionContext = {
  version: 1,
  requestText: "Protect my BTC against a drop below $65k this week, spend at most $50.",
  planId: "plan_01",
  rungIndex: 2,
  ladderSummary: {
    eventTicker: "BTC2611202200",
    observedAt: "2026-11-15T18:00:00.000Z",
    rungs: [
      {
        instrumentSymbol: "GEMI-BTC2611202200-HI65000",
        label: "BTC above $65,000",
        yesBidCents: 64,
        yesAskCents: 66,
      },
      {
        instrumentSymbol: "GEMI-BTC2611202200-HI60000",
        label: "BTC above $60,000",
        yesBidCents: null,
        yesAskCents: 90,
      },
    ],
  },
  signalReceiptIds: ["rcpt_a", "rcpt_b"],
  reason: "Cheapest rung that covers the requested drop.",
  createdAt: "2026-11-15T18:00:05.000Z",
};

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    expect(canonicalJson(reordered)).toBe(canonicalJson(doc));
  });

  it("escapes strings like JSON and handles unicode", () => {
    expect(canonicalJson({ s: 'quote " and é and \n' })).toBe('{"s":"quote \\" and é and \\n"}');
  });

  it("rejects values JSON cannot represent exactly", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalJsonError);
  });
});

describe("hashContext and verifyContext", () => {
  it("hashes the canonical JSON with keccak256", () => {
    expect(hashContext(doc)).toBe(keccak256(stringToBytes(canonicalJson(doc))));
    expect(hashContext(doc)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable across key order and verifies", () => {
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(doc).reverse())),
    ) as unknown;
    const hash = hashContext(doc);
    expect(verifyContext(reordered, hash)).toBe(true);
    expect(verifyContext(doc, hash.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("detects any rewrite", () => {
    const hash = hashContext(doc);
    expect(verifyContext({ ...doc, reason: "A different story." }, hash)).toBe(false);
    expect(verifyContext({ ...doc, rungIndex: 1 }, hash)).toBe(false);
    expect(verifyContext({ ...doc, signalReceiptIds: ["rcpt_b", "rcpt_a"] }, hash)).toBe(false);
  });

  it("rejects malformed documents, unknown keys and bad hashes without throwing", () => {
    const hash = hashContext(doc);
    expect(verifyContext({ ...doc, extra: "not covered by the schema" }, hash)).toBe(false);
    expect(verifyContext({ ...doc, version: 2 }, hash)).toBe(false);
    expect(verifyContext(null, hash)).toBe(false);
    expect(verifyContext(doc, "0x1234")).toBe(false);
    expect(() => hashContext({ ...doc, rungIndex: 1.5 })).toThrow();
  });
});
