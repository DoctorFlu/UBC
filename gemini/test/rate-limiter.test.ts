import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/index";
import { fakeClock, json, testClient } from "./helpers";

describe("TokenBucket", () => {
  it("never lets more than 120 requests through in any 60-second window", async () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket({
      capacity: 5,
      refillPerMinute: 100,
      now: clock.read,
      sleep: clock.sleep,
    });
    const stamps: number[] = [];
    for (let i = 0; i < 400; i++) {
      await bucket.acquire();
      stamps.push(clock.now);
    }
    let worst = 0;
    for (let i = 0, j = 0; i < stamps.length; i++) {
      while ((stamps[i] ?? 0) - (stamps[j] ?? 0) >= 60_000) j++;
      worst = Math.max(worst, i - j + 1);
    }
    expect(worst).toBeLessThanOrEqual(105);
    expect(worst).toBeGreaterThan(100);
  });

  it("serves concurrent waiters in order", async () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 60, now: clock.read, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => bucket.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(clock.now).toBe(3000);
  });

  it("validates its settings", () => {
    const clock = fakeClock(0);
    expect(
      () => new TokenBucket({ capacity: 0, refillPerMinute: 1, now: clock.read, sleep: clock.sleep }),
    ).toThrow(RangeError);
  });

  it("paces client requests", async () => {
    const clock = fakeClock(0);
    const client = testClient(() => Promise.resolve(json({ bids: [], asks: [] })), clock, {
      rateLimit: { capacity: 2, refillPerMinute: 60 },
      cacheTtlMs: { book: 0 },
    });
    for (let i = 0; i < 5; i++) await client.getOrderBook("GEMI-X");
    // Two from the burst, then one per second.
    expect(clock.now).toBe(3000);
  });
});
