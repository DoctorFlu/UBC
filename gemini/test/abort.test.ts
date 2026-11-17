/**
 * Every client method takes an abort signal (issue #105): the caller's deadline aborts the requests
 * in flight, nothing is retried after it, and a request other callers share goes on for them.
 */
import { describe, expect, it, vi } from "vitest";
import { TokenBucket, type FetchLike } from "../src/index";
import { fakeClock, fixture, json, testClient } from "./helpers";

/** A fetch whose requests never answer; it records each one and whether it was aborted. */
function stalled() {
  const requests: { path: string; aborted: boolean }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const entry = { path: new URL(input).pathname, aborted: false };
    requests.push(entry);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        entry.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  return { fetch: fetchImpl, requests };
}

const reason = () => new Error("the call ran out of time");

describe("abort signals", () => {
  it("aborts the request in flight with the caller's reason and never retries it", async () => {
    const api = stalled();
    const client = testClient(api.fetch, fakeClock(), { timeoutMs: 60_000, maxRetries: 3 });
    const stop = new AbortController();
    const spot = client.getSpot("BTC", { signal: stop.signal });
    await vi.waitFor(() => {
      expect(api.requests).toHaveLength(1);
    });
    const why = reason();
    stop.abort(why);
    await expect(spot).rejects.toBe(why);
    expect(api.requests).toEqual([{ path: "/v1/pubticker/btcusd", aborted: true }]);
  });

  it("sends nothing for a signal that has already aborted", async () => {
    const api = stalled();
    const stop = new AbortController();
    stop.abort(reason());
    await expect(testClient(api.fetch).getSpot("BTC", { signal: stop.signal })).rejects.toThrow(
      "ran out of time",
    );
    expect(api.requests).toHaveLength(0);
  });

  it("keeps a shared request going while another caller still waits for it", async () => {
    let answer: (response: Response) => void = () => undefined;
    let aborted = false;
    let calls = 0;
    const fetchImpl: FetchLike = (_input, init) => {
      calls++;
      return new Promise((resolve, reject) => {
        answer = resolve;
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const client = testClient(fetchImpl, fakeClock(), { timeoutMs: 60_000 });
    const quitter = new AbortController();
    const first = client.getSpot("BTC", { signal: quitter.signal });
    const second = client.getSpot("BTC");
    await Promise.resolve();
    quitter.abort(reason());
    await expect(first).rejects.toThrow("ran out of time");
    expect(aborted).toBe(false);
    answer(json(fixture("pubticker-btcusd.json")));
    await expect(second).resolves.toMatchObject({ midCents: 6_471_001 });
    expect(calls).toBe(1);
  });

  it("aborts a shared request once every caller has given up, and starts afresh after", async () => {
    const api = stalled();
    const client = testClient(api.fetch, fakeClock(), { timeoutMs: 60_000 });
    const a = new AbortController();
    const b = new AbortController();
    const first = client.getSpot("BTC", { signal: a.signal });
    const second = client.getSpot("BTC", { signal: b.signal });
    await vi.waitFor(() => {
      expect(api.requests).toHaveLength(1);
    });
    a.abort(reason());
    await expect(first).rejects.toThrow();
    expect(api.requests[0]?.aborted).toBe(false);
    b.abort(reason());
    await expect(second).rejects.toThrow();
    expect(api.requests[0]?.aborted).toBe(true);
    const c = new AbortController();
    const third = client.getSpot("BTC", { signal: c.signal });
    await vi.waitFor(() => {
      expect(api.requests).toHaveLength(2);
    });
    c.abort(reason());
    await expect(third).rejects.toThrow();
    expect(api.requests[1]?.aborted).toBe(true);
  });

  it("stops waiting for a rate-limit token without using one", async () => {
    const clock = { now: 0 };
    let wake: () => void = () => undefined;
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerMinute: 60,
      now: () => clock.now,
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    await bucket.acquire();
    const stop = new AbortController();
    const waiting = bucket.acquire(stop.signal);
    await Promise.resolve();
    stop.abort(reason());
    await expect(waiting).rejects.toThrow("ran out of time");
    // The token the abandoned waiter would have taken is still there for the next caller.
    clock.now = 1_000;
    wake();
    const next = bucket.acquire();
    clock.now = 1_000;
    wake();
    await expect(next).resolves.toBeUndefined();
  });
});
