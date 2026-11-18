import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tunnelUrlIn } from "../scripts/tunnel-url";

/** A real `cloudflared tunnel --url` log (2026.11.0), with the machine's addresses and ids replaced. */
const SUCCESS_LOG = readFileSync(new URL("./fixtures/cloudflared-quick-tunnel.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0);

describe("tunnelUrlIn", () => {
  it("finds exactly one tunnel URL in a real cloudflared log: the one in the box", () => {
    const found = SUCCESS_LOG.map(tunnelUrlIn).filter((url) => url !== null);
    expect(found).toEqual(["https://and-judgment-related-profiles.trycloudflare.com"]);
  });

  it("ignores the lines that name trycloudflare.com without a tunnel", () => {
    const requesting = SUCCESS_LOG.find((line) => line.includes("Requesting new quick Tunnel"));
    expect(requesting).toBeDefined();
    expect(tunnelUrlIn(requesting ?? "")).toBeNull();
  });

  // In the form of cloudflared's quick tunnel errors (cmd/cloudflared/tunnel/quick_tunnel.go): a failed
  // request to its API at https://api.trycloudflare.com/tunnel, after which cloudflared exits with code 1.
  it.each([
    '2026-11-17T22:58:02Z ERR Error requesting quick Tunnel error="failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: lookup api.trycloudflare.com: no such host"',
    "2026-11-17T22:58:02Z ERR failed to unmarshal quick Tunnel: invalid character '<' looking for beginning of value url=https://api.trycloudflare.com",
    "2026-11-17T22:58:02Z INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel...",
  ])("never takes Cloudflare's own API host for a tunnel: %s", (line) => {
    expect(tunnelUrlIn(line)).toBeNull();
  });

  it("takes a tunnel URL only from an INF line, and only as a bare origin", () => {
    expect(tunnelUrlIn("2026-11-17T23:03:19Z INF |  https://a-b-c.trycloudflare.com   |")).toBe(
      "https://a-b-c.trycloudflare.com",
    );
    expect(tunnelUrlIn("2026-11-17T23:03:19Z ERR |  https://a-b-c.trycloudflare.com   |")).toBeNull();
    expect(tunnelUrlIn("2026-11-17T23:03:19Z INF see https://a-b-c.trycloudflare.com/health")).toBeNull();
    expect(tunnelUrlIn("2026-11-17T23:03:19Z INF https://a-b-c.trycloudflare.com.evil.example")).toBeNull();
  });
});
