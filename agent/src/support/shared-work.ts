/**
 * One run of some work shared by every caller that asks for it while it runs, such as catching up
 * with the chain's events. A caller whose signal aborts stops waiting at once; the run itself is
 * aborted only when no caller is left waiting, so one caller giving up never fails another, and
 * nothing keeps running for nobody.
 */
export class SharedWork<T> {
  readonly #start: (signal: AbortSignal) => Promise<T>;
  #current:
    { promise: Promise<T>; controller: AbortController; waiters: number; pinned: boolean } | undefined;

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.#start = start;
  }

  /** Waits for the run in progress, starting one when none is. Without a signal, the run always finishes. */
  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    let run = this.#current;
    if (run === undefined) {
      const controller = new AbortController();
      const promise = this.#start(controller.signal);
      const started = { promise, controller, waiters: 0, pinned: false };
      this.#current = started;
      const done = () => {
        if (this.#current === started) this.#current = undefined;
      };
      promise.then(done, done);
      run = started;
    }
    if (signal === undefined) {
      run.pinned = true;
      return run.promise;
    }
    const joined = run;
    joined.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        joined.waiters -= 1;
        if (joined.waiters === 0 && !joined.pinned && this.#current === joined) {
          this.#current = undefined;
          joined.controller.abort(signal.reason);
        }
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void joined.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }
}
