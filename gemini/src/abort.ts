/** Per-call options every client method takes. */
export interface RequestOptions {
  /**
   * Stops the call: requests in flight are aborted, nothing is retried, and the call rejects with
   * the signal's reason. A cached request other callers still wait for goes on.
   */
  signal?: AbortSignal | undefined;
}
