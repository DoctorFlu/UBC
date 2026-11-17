/**
 * Reading a quick tunnel's public URL from cloudflared's log, for `npm run dev:tunnel`.
 *
 * cloudflared prints the URL in a box ("Your quick Tunnel has been created! Visit it at ...") on an INF
 * line. Its own API lives on the same domain (`https://api.trycloudflare.com/tunnel`) and appears in error
 * lines when a request for a tunnel fails, so only an INF line counts, and only a bare origin on a host
 * that is not one of Cloudflare's own.
 */

/** A quick tunnel's origin: one generated label under trycloudflare.com, with no path after it. */
const TUNNEL_ORIGIN = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com(?![\w./-])/g;

/** Hosts under trycloudflare.com that belong to Cloudflare's service, never to a tunnel. */
const SERVICE_HOSTS = new Set(["api", "www"]);

/** The tunnel's public origin if this cloudflared log line announces one, else null. */
export function tunnelUrlIn(line: string): string | null {
  if (!/\sINF\s/.test(line)) return null;
  for (const match of line.matchAll(TUNNEL_ORIGIN)) {
    const label = match[1];
    if (label !== undefined && !SERVICE_HOSTS.has(label)) return match[0];
  }
  return null;
}

/** How many times `dev:tunnel` asks for a quick tunnel when cloudflared exits before it gave one. */
export const TUNNEL_ATTEMPTS = 3;

/** How long it waits before asking again. */
export const TUNNEL_RETRY_MS = 3_000;
