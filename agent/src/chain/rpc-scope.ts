/**
 * Abort signals for chain RPC requests.
 *
 * viem's actions take no abort signal, so the signal of the policy call in progress travels with the
 * async context instead: `withSignal` runs a call under a signal, and `scopedFetch`, the fetch of the
 * agent's viem transport, aborts every request made inside it when that signal aborts.
 *
 * A proposal swaps the signal right before its broadcast (`shieldCurrentScope`): from then on the
 * caller's signal (its deadline, the client going away) no longer cuts anything, and only the bound
 * the proposal set for its broadcast and receipt does. Once a transaction may be out, the caller must
 * learn what became of it, within a known time.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RpcScope {
  /** Aborts the requests made in this scope; undefined once shielded without a bound. */
  signal: AbortSignal | undefined;
}

const scope = new AsyncLocalStorage<RpcScope>();

/** Runs `work` with every RPC request it makes aborted when `signal` aborts. */
export function withSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return scope.run({ signal }, work);
}

/** Runs `work` outside any caller's signal: for work shared by callers or cached for the process. */
export function unscoped<T>(work: () => Promise<T>): Promise<T> {
  return scope.exit(work);
}

/**
 * From now on, requests made in the current scope are no longer aborted by its caller's signal, only
 * by `bound` (when given): the most the rest of a broadcast proposal may take.
 */
export function shieldCurrentScope(bound?: AbortSignal): void {
  const current = scope.getStore();
  if (current !== undefined) current.signal = bound;
}

/**
 * The signal of the policy call in progress, for requests made inside it that are not RPC requests
 * (the console signing an agent's proposal); undefined outside a call, or once shielded without a bound.
 */
export function currentScopeSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

/** `fetch` for viem's http transport that honours the current scope's signal. */
export function scopedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const signal = scope.getStore()?.signal;
  if (signal === undefined) return fetch(input, init);
  const own = init?.signal ?? undefined;
  return fetch(input, {
    ...init,
    signal: own === undefined ? signal : AbortSignal.any([own, signal]),
  });
}
