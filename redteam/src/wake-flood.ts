/**
 * Replays rejected intents read from the chain through the console's wake-up rules (`chainWakes`) and
 * notifier (`WakeNotifier`, the classes the console runs) on a simulated clock: the same burst again and
 * again, as an attacker holding the agent key could send it all day, with no Bot run in progress so no
 * rejection is dropped as the run's own. A local stand-in answers 200 for the routine's webhook; no real
 * webhook is called.
 */
import {
  type PolicyEvent,
  MemoryWakeStore,
  WAKE_DEBOUNCE_MS,
  WAKE_DEFAULT_DAILY_CAP,
  WakeNotifier,
  WakeTarget,
  chainWakes,
} from "@mandate/shared";

const DAY_MS = 86_400_000;
/** Six hours before a UTC midnight, so a run of 30 hours spans two UTC days. */
const START = Date.parse("2026-11-20T18:00:00Z");

export interface WakeFlood {
  /** Rejections offered to the rules, over every burst. */
  offered: number;
  /** Wake-ups posted to the webhook, with when (ms from the start). */
  postedAt: number[];
  /** The most posted in one UTC day. */
  busiestDay: number;
  /** The shortest time between two posts, or null with fewer than two. */
  shortestGapMs: number | null;
  cap: number;
}

/**
 * Sends `events` (the attacker's proposals and their rejections) as one burst every `everyMinutes`
 * for `hours`, each burst as new transactions, and lets the notifier run until the last wake-up waiting
 * has been sent or capped.
 */
export async function floodWakes(
  events: readonly PolicyEvent[],
  options: { hours: number; everyMinutes: number; cap?: number },
): Promise<WakeFlood> {
  let now = START;
  let timers: { at: number; task: () => void }[] = [];
  const schedule = (task: () => void, ms: number) => {
    const timer = { at: now + ms, task };
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  const advanceTo = async (end: number) => {
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      now = Math.max(now, next.at);
      next.task();
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    now = end;
  };

  const postedAt: number[] = [];
  const cap = options.cap ?? WAKE_DEFAULT_DAILY_CAP;
  const notifier = new WakeNotifier({
    target: new WakeTarget("http://127.0.0.1:9/routine-webhook-stand-in", "red-team-stand-in-key"),
    dailyCap: cap,
    store: new MemoryWakeStore(),
    fetch: () => {
      postedAt.push(now - START);
      return Promise.resolve(new Response(null, { status: 200 }));
    },
    now: () => now,
    schedule,
  });
  notifier.start();

  let offered = 0;
  const bursts = Math.floor((options.hours * 60) / options.everyMinutes);
  for (let burst = 0; burst < bursts; burst++) {
    await advanceTo(START + burst * options.everyMinutes * 60_000);
    const seconds = Math.floor(now / 1000);
    const replayed = events.map((event) => ({ ...event, blockTimestamp: seconds }));
    offered += replayed.filter((event) => event.type === "IntentRejected").length;
    const { wakes } = chainWakes(replayed, replayed, {
      deploymentId: `burst-${String(burst)}`,
      now,
      runInProgress: false,
      history: false,
    });
    notifier.offer(wakes);
  }
  await advanceTo(now + 2 * 3_600_000);
  notifier.stop();

  const perDay = new Map<number, number>();
  for (const at of postedAt) {
    const day = Math.floor((START + at) / DAY_MS);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const gaps = postedAt.slice(1).map((at, i) => at - (postedAt[i] ?? 0));
  return {
    offered,
    postedAt,
    busiestDay: Math.max(0, ...perDay.values()),
    shortestGapMs: gaps.length === 0 ? null : Math.min(...gaps),
    cap,
  };
}

/** The least time between two rejection wake-ups. */
export const REJECTION_DEBOUNCE_MS = WAKE_DEBOUNCE_MS.intent_rejected;
