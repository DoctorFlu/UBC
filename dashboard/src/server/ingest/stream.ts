import "server-only";

import {
  type HeaderBag,
  type StreamBatch,
  parseStreamBatch,
  verifyQuickNodeSignature,
} from "@mandate/streams";

/** How long a seen nonce is remembered: the signature's own replay window plus a margin. */
const NONCE_TTL_MS = 10 * 60 * 1000;

export type StreamCheck =
  | { ok: true; duplicate: true }
  | { ok: true; duplicate: false; nonce: string; batch: StreamBatch }
  | { ok: false; status: number; code: string; message: string };

/**
 * Checks QuickNode Stream webhook deliveries before anything is stored: the HMAC signature and its
 * timestamp window (`@mandate/streams`), then nonce replay within the window, then the payload shape.
 * A nonce is remembered only once its delivery is stored, so a failed delivery can be retried; after
 * that, a replay is acknowledged without processing so QuickNode does not retry it. A batch delivered
 * again with a fresh signature passes, and the event store ignores its events by (tx hash, log index).
 */
export class StreamReceiver {
  private readonly nonces = new Map<string, number>();

  constructor(
    private readonly securityToken: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.securityToken !== null;
  }

  check(headers: HeaderBag, rawBody: string): StreamCheck {
    if (this.securityToken === null) {
      return {
        ok: false,
        status: 503,
        code: "stream_disabled",
        message: "The Stream webhook is off: set QUICKNODE_STREAM_SECURITY_TOKEN on the console.",
      };
    }
    const verified = verifyQuickNodeSignature(headers, rawBody, this.securityToken, { now: this.now });
    if (!verified.ok) {
      return { ok: false, status: 401, code: verified.reason, message: verified.detail };
    }

    this.forgetExpired();
    if (this.nonces.has(verified.nonce)) return { ok: true, duplicate: true };

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, status: 400, code: "invalid_json", message: "The delivery body is not JSON." };
    }
    let batch: StreamBatch;
    try {
      batch = parseStreamBatch(body);
    } catch (error) {
      return {
        ok: false,
        status: 422,
        code: "invalid_payload",
        message:
          error instanceof Error ? (error.message.split("\n")[0] ?? "Invalid payload") : "Invalid payload",
      };
    }
    return { ok: true, duplicate: false, nonce: verified.nonce, batch };
  }

  /** Call once a delivery is stored, so a replay of it is acknowledged without processing. */
  remember(nonce: string): void {
    this.nonces.set(nonce, this.now() + NONCE_TTL_MS);
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [nonce, expires] of this.nonces) {
      if (expires <= now) this.nonces.delete(nonce);
    }
  }
}
