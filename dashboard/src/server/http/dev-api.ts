import "server-only";

import { z } from "zod";

import { serviceRoute } from "./agent-api";
import { apiError, json, readBody } from "./responses";

const DAY_MS = 86_400_000;

export const advanceWakeClockSchema = z.strictObject({
  /** How far to move the wake-ups' clock forward, in milliseconds: at most a day at a time. */
  advanceMs: z.int().min(0).max(DAY_MS),
});

/**
 * POST /api/dev/wake-clock with `{ advanceMs }` and the service token: moves the wake-ups' test clock
 * forward and answers once what was due by then has been sent (issue #110). A console without
 * `GROK_WAKE_TEST_CLOCK=on`, which production refuses to start with, answers 404.
 */
export const postWakeClock = serviceRoute(async (request, service) => {
  const clock = service.wakeClock;
  if (!clock) return apiError(404, "not_found", "This console has no test clock.");
  const body = await readBody(request, advanceWakeClockSchema);
  if (!body.ok) return body.response;
  clock.advance(body.data.advanceMs);
  await service.wake.settled();
  return json({ now: new Date(clock.now()).toISOString(), offsetMs: clock.offsetMs });
});
