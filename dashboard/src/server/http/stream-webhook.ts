import "server-only";

import type { ConsoleService } from "../console-service";
import { apiError, json } from "./responses";

/** Largest delivery accepted. Policy logs are small; a filtered Arc batch is a few kilobytes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * QuickNode Stream webhook: verify, then feed the same pipeline as the RPC poller.
 * - 401 for a bad or stale signature (the only reason QuickNode should see a 4xx for a real delivery);
 * - 200 `duplicate` for a nonce already processed, so QuickNode does not retry it;
 * - 503 while the console has no live deployment, so QuickNode retries later instead of losing data.
 */
export async function receiveStreamDelivery(request: Request, service: ConsoleService): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return apiError(413, "too_large", "The delivery is larger than 2 MB.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return apiError(413, "too_large", "The delivery is larger than 2 MB.");
  }

  const check = service.stream.check(request.headers, raw);
  if (!check.ok) return apiError(check.status, check.code, check.message);
  if (check.duplicate) return json({ status: "duplicate" });

  const result = await service.ingestStreamBatch(check.batch);
  if (!result) {
    return apiError(
      503,
      "not_ready",
      "The console is not connected to the Policy contract yet. Retry shortly.",
    );
  }
  service.stream.remember(check.nonce);
  return json({ status: "stored", received: result.received, stored: result.stored });
}
