/**
 * Settles like `promise`, or rejects with the signal's reason as soon as it aborts. The promise
 * itself is not cancelled: use this only for a wait that holds no work of its own (a queue, a lock,
 * a result shared with other callers), or on top of work the same signal already aborts.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
