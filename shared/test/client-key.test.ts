import { describe, expect, it } from "vitest";
import { clientKey, isPrivateAddress } from "../src/node";

function from(forwardedFor?: string): Request {
  return new Request("http://console.test/", {
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  });
}

describe("clientKey", () => {
  it("shares one key for every request without a trusted proxy, whatever the header says", () => {
    expect(clientKey(from("203.0.113.7"), false)).toBe("direct");
    expect(clientKey(from(), false)).toBe("direct");
  });

  it("takes the right-most public address the proxies saw", () => {
    expect(clientKey(from("203.0.113.7"), true)).toBe("203.0.113.7");
    expect(clientKey(from("203.0.113.7, 10.0.0.2"), true)).toBe("203.0.113.7");
    expect(clientKey(from("2001:db8::1, 172.18.0.5"), true)).toBe("2001:db8::1");
  });

  it("cannot be chosen by a client that writes its own X-Forwarded-For", () => {
    // The client claims a new address on each try; Caddy appends the one it saw, which stays the key.
    expect(clientKey(from("198.51.100.1, 203.0.113.7"), true)).toBe("203.0.113.7");
    expect(clientKey(from("198.51.100.2, 203.0.113.7"), true)).toBe("203.0.113.7");
    expect(clientKey(from("not-an-ip, 203.0.113.7"), true)).toBe("203.0.113.7");
  });

  it("falls back to the nearest peer when every address is private", () => {
    expect(clientKey(from("10.0.0.9, 172.18.0.5"), true)).toBe("172.18.0.5");
    expect(clientKey(from(), true)).toBe("unknown");
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "::ffff:10.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("%s is private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "100.128.0.1", "172.32.0.1", "203.0.113.7", "2001:db8::1", "::ffff:8.8.8.8"])(
    "%s is public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});
