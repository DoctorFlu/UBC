import { describe, expect, it } from "vitest";
import { bearerToken, constantTimeEqual, isAuthorized } from "../src/http/auth";
import { TokenBucketLimiter } from "../src/http/rate-limit";
import { Secret } from "../src/secret";

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("é", "e")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc.DEF-123_")).toBe("abc.DEF-123_");
    expect(bearerToken("bearer   abc")).toBe("abc");
  });

  it("returns undefined for anything else", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken("Bearerabc")).toBeUndefined();
  });
});

describe("isAuthorized", () => {
  const expected = new Secret("t".repeat(40));
  it("accepts only the expected token", () => {
    expect(isAuthorized(`Bearer ${"t".repeat(40)}`, expected)).toBe(true);
    expect(isAuthorized(`Bearer ${"t".repeat(39)}`, expected)).toBe(false);
    expect(isAuthorized(undefined, expected)).toBe(false);
  });
});

describe("TokenBucketLimiter", () => {
  it("allows a burst of `capacity`, then refills over time", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
    expect(limiter.take("b")).toBe(0);
    now += 1000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
    now += 60_000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
  });
});
