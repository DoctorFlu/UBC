import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { computeQuickNodeSignature, verifyQuickNodeSignature } from "../src/signature";

// QuickNode publishes the construction (hex HMAC-SHA256 over nonce + timestamp + body, keyed by the
// Stream security token) but no test vectors. These were computed independently with
// `openssl dgst -sha256 -hmac`, not with this module.
const TOKEN = "mandate-test-security-token-0123456789abcdef";
const FIXTURE = readFileSync(new URL("./fixtures/arc-testnet-logs-dataset.json", import.meta.url));

const VECTORS = [
  {
    name: "small JSON body",
    nonce: "b2f1c3a4d5e6f708192a3b4c5d6e7f80",
    timestamp: "1763210000",
    body: '{"data":[],"metadata":{"network":"arc-testnet"}}',
    signature: "087dceb875f9ccfecd2d10887eb27071253072990b12bb0f61c3d3a51b28ecdf",
  },
  {
    name: "non-ASCII nonce and body hashed as UTF-8",
    nonce: "nonce-ü",
    timestamp: "1763210000",
    body: '{"note":"café ✓"}',
    signature: "39afddf7f2802e93d2b2bdac4fb1f4634eddf3df5558f7012d66871ac58906dc",
  },
  {
    name: "recorded Arc testnet logs payload, as bytes",
    nonce: "02c6d2644296c8b830970891410825a3",
    timestamp: "1763210123",
    body: FIXTURE,
    signature: "b649c5feb663d043c19eb87888e592e8e0d9f4da6fa5c0c4d9080575f52d7dc1",
  },
] as const;

function headersFor(nonce: string, timestamp: string, signature: string) {
  return { "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature };
}

const at = (seconds: string) => () => Number(seconds) * 1000;

describe("computeQuickNodeSignature", () => {
  it.each(VECTORS)("matches the openssl vector: $name", (vector) => {
    expect(computeQuickNodeSignature(TOKEN, vector.nonce, vector.timestamp, vector.body)).toBe(
      vector.signature,
    );
  });

  it("gives the same result for a string body and its UTF-8 bytes", () => {
    const text = FIXTURE.toString("utf8");
    expect(computeQuickNodeSignature(TOKEN, "n", "1", text)).toBe(
      computeQuickNodeSignature(TOKEN, "n", "1", FIXTURE),
    );
  });

  it("refuses an empty security token", () => {
    expect(() => computeQuickNodeSignature("", "n", "1", "{}")).toThrow(/empty/);
  });
});

describe("verifyQuickNodeSignature", () => {
  it.each(VECTORS)("accepts the vector: $name", (vector) => {
    const result = verifyQuickNodeSignature(
      headersFor(vector.nonce, vector.timestamp, vector.signature),
      vector.body,
      TOKEN,
      { now: at(vector.timestamp) },
    );
    expect(result).toEqual({ ok: true, nonce: vector.nonce, timestamp: Number(vector.timestamp) });
  });

  it("reads Fetch Headers case-insensitively, as Node and undici deliver them", () => {
    const [vector] = VECTORS;
    const headers = new Headers({
      "X-QN-Nonce": vector.nonce,
      "X-QN-Timestamp": vector.timestamp,
      "X-QN-Signature": vector.signature.toUpperCase(),
    });
    expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now: at(vector.timestamp) }).ok).toBe(
      true,
    );
  });

  it("reads mixed-case keys from a plain record", () => {
    const [vector] = VECTORS;
    const headers = {
      "X-QN-Nonce": vector.nonce,
      "X-Qn-Timestamp": vector.timestamp,
      "x-qn-signature": vector.signature,
    };
    expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now: at(vector.timestamp) }).ok).toBe(
      true,
    );
  });

  it("verifies a gzip delivery over the decompressed body, not the wire bytes", () => {
    const vector = VECTORS[2];
    const wire = gzipSync(vector.body);
    const headers = headersFor(vector.nonce, vector.timestamp, vector.signature);
    const options = { now: at(vector.timestamp) };
    expect(verifyQuickNodeSignature(headers, wire, TOKEN, options)).toMatchObject({
      ok: false,
      reason: "signature_mismatch",
    });
    expect(verifyQuickNodeSignature(headers, gunzipSync(wire), TOKEN, options).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const [vector] = VECTORS;
    const result = verifyQuickNodeSignature(
      headersFor(vector.nonce, vector.timestamp, vector.signature),
      vector.body.replace("arc-testnet", "arc-mainnet"),
      TOKEN,
      { now: at(vector.timestamp) },
    );
    expect(result).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a moved timestamp or nonce, which the signature binds", () => {
    const [vector] = VECTORS;
    const options = { now: at(vector.timestamp) };
    expect(
      verifyQuickNodeSignature(headersFor(vector.nonce, "1763210001", vector.signature), vector.body, TOKEN, {
        now: at("1763210001"),
      }),
    ).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(
      verifyQuickNodeSignature(
        headersFor("other", vector.timestamp, vector.signature),
        vector.body,
        TOKEN,
        options,
      ),
    ).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects the wrong security token", () => {
    const [vector] = VECTORS;
    const result = verifyQuickNodeSignature(
      headersFor(vector.nonce, vector.timestamp, vector.signature),
      vector.body,
      `${TOKEN}x`,
      { now: at(vector.timestamp) },
    );
    expect(result).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("reports missing and malformed headers before computing anything", () => {
    const [vector] = VECTORS;
    expect(verifyQuickNodeSignature({}, vector.body, TOKEN)).toMatchObject({ reason: "missing_header" });
    expect(
      verifyQuickNodeSignature(headersFor(vector.nonce, vector.timestamp, "abc"), vector.body, TOKEN),
    ).toMatchObject({ reason: "malformed_signature" });
    expect(
      verifyQuickNodeSignature(
        headersFor(vector.nonce, "2025-11-15T10:00:00Z", vector.signature),
        vector.body,
        TOKEN,
      ),
    ).toMatchObject({ reason: "malformed_timestamp" });
    expect(
      verifyQuickNodeSignature(
        { "x-qn-nonce": ["a", "b"], "x-qn-timestamp": vector.timestamp, "x-qn-signature": vector.signature },
        vector.body,
        TOKEN,
      ),
    ).toMatchObject({ reason: "missing_header" });
  });

  describe("replay window", () => {
    const [vector] = VECTORS;
    const headers = headersFor(vector.nonce, vector.timestamp, vector.signature);
    const signedAt = Number(vector.timestamp);

    it("accepts a delivery inside the default 300 s window", () => {
      const now = () => (signedAt + 300) * 1000;
      expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now }).ok).toBe(true);
    });

    it("rejects a replay after the window", () => {
      const now = () => (signedAt + 301) * 1000;
      expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now })).toMatchObject({
        ok: false,
        reason: "stale_timestamp",
      });
    });

    it("rejects a timestamp too far in the future", () => {
      const now = () => (signedAt - 301) * 1000;
      expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now })).toMatchObject({
        reason: "stale_timestamp",
      });
    });

    it("honours a custom window and can be disabled", () => {
      const now = () => (signedAt + 3600) * 1000;
      expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now, maxAgeSeconds: 7200 }).ok).toBe(
        true,
      );
      expect(verifyQuickNodeSignature(headers, vector.body, TOKEN, { now, maxAgeSeconds: null }).ok).toBe(
        true,
      );
    });
  });
});
