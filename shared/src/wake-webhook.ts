/**
 * The outbound call to a webhook address an owner typed in (issue #112). The console calls it, so it is an
 * SSRF surface: the address must not reach the console's own network, its cloud metadata service, or any
 * host the operator did not name. Node only: import it from `@mandate/shared/node`.
 *
 * - HTTPS on the default port only, unless the operator's allowlist names a port; no credentials in it.
 * - The host must be on the operator's allowlist, compared exactly after the WHATWG parser (so on the
 *   punycode form), with no suffix or wildcard matching.
 * - Every address the name resolves to must be public; the connection goes to the address that was
 *   checked, so a second DNS answer cannot move it (no rebinding window). The certificate is still checked
 *   against the name.
 * - A redirect is never followed, the body is never read, and the request is bounded in time and in the
 *   size of the headers it accepts.
 *
 * The test switch (`allowLocal`, `GROK_WAKE_TEST_RECEIVERS=on`, refused in production) admits plain HTTP
 * and loopback addresses only, and only for a host and port the allowlist names exactly.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import { WakeRefused, type WakeFetch } from "./wake-notifier";

/** Where per-agent webhooks may post. */
export interface WebhookPolicy {
  /** Hosts, each `name` or `name:port`, as the operator wrote them; empty turns per-agent webhooks off. */
  hosts: readonly string[];
  /** Test receivers only: plain HTTP and loopback addresses, for a host and port the list names. */
  allowLocal: boolean;
}

/** Why an address was refused: a fixed reason, never the address or anything the server answered. */
export type WebhookRefusal =
  "not_a_url" | "not_https" | "credentials" | "host_not_allowed" | "address_not_allowed" | "no_address";

export const WEBHOOK_REFUSALS: Record<WebhookRefusal, string> = {
  not_a_url: "That is not a web address.",
  not_https: "The address must use https.",
  credentials: "The address must not carry a user name or password.",
  host_not_allowed: "This console does not post wake-ups to that host.",
  address_not_allowed: "That host points to a private network address, so the console will not call it.",
  no_address: "That host has no address the console can reach.",
};

/** Most bytes of response headers accepted; the body is never read. */
const MAX_HEADER_BYTES = 16 * 1024;

/**
 * Every range a webhook must never reach: private, loopback, link-local and metadata, and the rest. One
 * list per family: a `BlockList` also matches IPv4 addresses against IPv6 rules for mapped addresses, so a
 * shared list would block every IPv4 address through `::ffff:0:0/96`.
 */
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and the cloud metadata service at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  blocked4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped: checked as IPv4 below as well
  ["64:ff9b::", 96], // NAT64 of IPv4
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, Teredo included
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["fc00::", 7], // unique local, and fd00:ec2::254 (a cloud metadata service)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(network, prefix, "ipv6");
}

const loopback4 = new BlockList();
loopback4.addSubnet("127.0.0.0", 8, "ipv4");
const loopback6 = new BlockList();
loopback6.addAddress("::1", "ipv6");

/** The IPv4 address an IPv4-mapped IPv6 address carries, or null. */
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1] ?? null;
}

/** Whether a webhook may never reach `address`: any range above, or an address that is not one. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked4.check(address, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(address);
    if (v4 !== null) return blocked4.check(v4, "ipv4");
    return blocked6.check(address, "ipv6");
  }
  return true;
}

function isLoopback(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return loopback4.check(address, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(address);
    return v4 !== null ? loopback4.check(v4, "ipv4") : loopback6.check(address, "ipv6");
  }
  return false;
}

/**
 * An allowlist entry as the WHATWG parser writes it under `protocol` (`name` or `name:port`, punycode),
 * or null when it is not a bare host.
 */
export function normalizeAllowedHost(entry: string, protocol: "https:" | "http:" = "https:"): string | null {
  const text = entry.trim();
  if (text === "" || /[/?#@\s\\]/.test(text)) return null;
  if (!URL.canParse(`${protocol}//${text}`)) return null;
  const url = new URL(`${protocol}//${text}`);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "") return null;
  return url.host;
}

/** A webhook address that passed the checks that need no DNS. */
export interface CheckedWebhookUrl {
  url: URL;
  /** The host as compared and as the console shows it: `name`, or `name:port` when a port is listed. */
  host: string;
}

/**
 * The checks that need no DNS: a URL, HTTPS (HTTP only for test receivers), no credentials, and a host the
 * allowlist names exactly (with its port, when it is not the default). Never quotes the input.
 */
export function checkWebhookUrl(
  text: string,
  policy: WebhookPolicy,
): { ok: true; checked: CheckedWebhookUrl } | { ok: false; reason: WebhookRefusal } {
  if (typeof text !== "string" || text.length > 2048 || !URL.canParse(text)) {
    return { ok: false, reason: "not_a_url" };
  }
  const url = new URL(text);
  const plainAllowed = policy.allowLocal && url.protocol === "http:";
  if (url.protocol !== "https:" && !plainAllowed) return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  const protocol = url.protocol === "http:" ? "http:" : "https:";
  const allowed = policy.hosts.some((entry) => normalizeAllowedHost(entry, protocol) === url.host);
  if (!allowed) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, checked: { url, host: url.host } };
}

/** How names are resolved; tests pass their own. */
export type WebhookResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

const systemResolver: WebhookResolver = (hostname) => dnsLookup(hostname, { all: true, order: "verbatim" });

/** The bracket-less host name a URL connects to. */
function connectName(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * The address to connect to: every address the name resolves to must be allowed (one private answer among
 * public ones refuses the lot, so the pick cannot be steered), and the first is used.
 */
export async function resolveWebhookAddress(
  url: URL,
  policy: WebhookPolicy,
  resolve: WebhookResolver = systemResolver,
): Promise<{ ok: true; address: LookupAddress } | { ok: false; reason: WebhookRefusal }> {
  const name = connectName(url);
  let addresses: readonly LookupAddress[];
  const literal = isIP(name);
  if (literal !== 0) {
    addresses = [{ address: name, family: literal }];
  } else {
    try {
      addresses = await resolve(name);
    } catch {
      return { ok: false, reason: "no_address" };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: "no_address" };
  const allowed = (address: string) =>
    !isBlockedAddress(address) || (policy.allowLocal && isLoopback(address));
  if (!addresses.every((entry) => allowed(entry.address)))
    return { ok: false, reason: "address_not_allowed" };
  const first = addresses[0];
  if (!first) return { ok: false, reason: "no_address" };
  return { ok: true, address: first };
}

/** Everything `checkWebhookUrl` and `resolveWebhookAddress` check, at once: when a webhook is saved. */
export async function vetWebhookUrl(
  text: string,
  policy: WebhookPolicy,
  resolve?: WebhookResolver,
): Promise<{ ok: true; host: string } | { ok: false; reason: WebhookRefusal }> {
  const checked = checkWebhookUrl(text, policy);
  if (!checked.ok) return checked;
  const resolved = await resolveWebhookAddress(checked.checked.url, policy, resolve);
  return resolved.ok ? { ok: true, host: checked.checked.host } : resolved;
}

/** The refusal a send turns into: refused, never retried, with a fixed reason. */
function refusedSend(reason: WebhookRefusal): WakeRefused {
  return new WakeRefused(`refused: ${WEBHOOK_REFUSALS[reason].replace(/\.$/, "").toLowerCase()}`);
}

/**
 * A `WakeFetch` that checks the address again on every send (the allowlist may have changed, and DNS may
 * now answer otherwise), connects to the address it checked, and answers with the status alone.
 */
export function guardedWakeFetch(
  policy: () => WebhookPolicy,
  options: { resolve?: WebhookResolver } = {},
): WakeFetch {
  return async (text, init) => {
    const current = policy();
    const checked = checkWebhookUrl(text, current);
    if (!checked.ok) throw refusedSend(checked.reason);
    const { url } = checked.checked;
    // The request's one time limit covers the name lookup too.
    const resolved = await untilAborted(resolveWebhookAddress(url, current, options.resolve), init.signal);
    if (!resolved.ok) {
      if (resolved.reason === "no_address") throw new Error("no address");
      throw refusedSend(resolved.reason);
    }
    const status = await post(url, resolved.address, init);
    return new Response(null, { status });
  };
}

/** `work`, or the signal's reason as soon as it aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  const reason = () => (signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(reason());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

/** One request to `address`, on the name's TLS certificate. Resolves with the status, before any body. */
function post(url: URL, address: LookupAddress, init: RequestInit): Promise<number> {
  const signal = init.signal ?? null;
  const body = typeof init.body === "string" ? init.body : "";
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request: ClientRequest = send(url, {
      method: "POST",
      headers,
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      // The address that was checked, whatever DNS would answer now. TLS still verifies the name.
      lookup: (_hostname, opts, callback) => {
        if ((opts as { all?: boolean }).all) {
          (callback as (error: null, addresses: LookupAddress[]) => void)(null, [address]);
        } else {
          (callback as (error: null, address: string, family: number) => void)(
            null,
            address.address,
            address.family,
          );
        }
      },
      ...(url.protocol === "https:" && isIP(connectName(url)) === 0 ? { servername: connectName(url) } : {}),
    });
    const onAbort = () => {
      request.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("response", (response: IncomingMessage) => {
      signal?.removeEventListener("abort", onAbort);
      const status = response.statusCode ?? 0;
      // The body is never read: whatever the receiver says stays there.
      response.destroy();
      request.destroy();
      resolve(status >= 200 && status <= 599 ? status : 502);
    });
    request.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error.name === "AbortError" && signal?.reason instanceof Error ? signal.reason : error);
    });
    request.end(body);
  });
}
