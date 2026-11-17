/**
 * The wake-ups' clock under `GROK_WAKE_TEST_CLOCK=on` (issue #110): real time plus an offset that only
 * moves forward, so the end-to-end tests can end a debounce window when they choose instead of waiting
 * ten minutes of wall clock, and a slow or sleeping machine can never end one for them.
 *
 * It runs at real speed between moves, so the price checks on the console's poll loop keep their
 * interval. Moving it runs every task scheduled on it that is due by then, at once.
 */
interface Scheduled {
  dueAt: number;
  task: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TestClock {
  #offsetMs = 0;
  readonly #scheduled = new Set<Scheduled>();

  constructor(private readonly realNow: () => number = Date.now) {}

  /** How far the clock is ahead of real time. */
  get offsetMs(): number {
    return this.#offsetMs;
  }

  readonly now = (): number => this.realNow() + this.#offsetMs;

  /** Runs `task` after `ms` on this clock; returns a cancel function. */
  readonly schedule = (task: () => void, ms: number): (() => void) => {
    const entry: Scheduled = {
      dueAt: this.now() + ms,
      task,
      timer: setTimeout(() => {
        this.#run(entry);
      }, ms),
    };
    (entry.timer as { unref?: () => void }).unref?.();
    this.#scheduled.add(entry);
    return () => {
      clearTimeout(entry.timer);
      this.#scheduled.delete(entry);
    };
  };

  /** Moves the clock forward by `ms` and runs what is due by then, earliest first. */
  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("the clock only moves forward");
    this.#offsetMs += ms;
    const now = this.now();
    const due = [...this.#scheduled].filter((entry) => entry.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
    for (const entry of due) this.#run(entry);
  }

  #run(entry: Scheduled): void {
    if (!this.#scheduled.delete(entry)) return;
    clearTimeout(entry.timer);
    entry.task();
  }
}
