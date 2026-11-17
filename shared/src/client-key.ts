/**
 * Who a request comes from, for rate limits, the same way in the console and the MCP server
 * (docs/accounts.md, "Rate limits"). Node only: import it from `@mandate/shared/node`.
 */
import { isIP } from "node:net";

/** Loopback, private, carrier-grade NAT, link-local and unspecified addresses: never a client's own. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

/**
 * The rate-limit key of a request. Behind a trusted proxy, the right-most public address in
 * `X-Forwarded-For`: each proxy appends the peer it saw, so the entries to its left are whatever the client
 * claimed and cannot choose the key. Without a trusted proxy the header is the client's own claim, so every
 * request shares one key and only the totals apply.
 */
export function clientKey(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return "direct";
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => isIP(entry.replace(/^::ffff:/i, "")) !== 0);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = chain[index] ?? "";
    if (!isPrivateAddress(address)) return address;
  }
  // Only private addresses: the nearest peer, which the client cannot choose.
  return chain.at(-1) ?? "unknown";
}
