import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  isDevchainRpc,
  isLoopbackUrl,
  isWellKnownAddress,
  isWellKnownKey,
  wellKnownKeyRefusal,
} from "../src/node";

/** Anvil's accounts 0, 1, 2 and 9, as anvil prints them. */
const ANVIL = {
  0: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  1: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  2: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  9: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const;

describe("well-known keys", () => {
  it("knows anvil's published keys and their addresses", () => {
    for (const key of Object.values(ANVIL)) {
      expect(isWellKnownKey(key)).toBe(true);
      expect(isWellKnownAddress(privateKeyToAccount(key).address)).toBe(true);
    }
    expect(isWellKnownAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
  });

  it("does not flag a fresh key, or text that is not a key", () => {
    expect(isWellKnownKey(generatePrivateKey())).toBe(false);
    expect(isWellKnownKey("not a key")).toBe(false);
  });

  it("refuses a published key anywhere but the local devchain, naming the variable and never the key", () => {
    const arc = { local: false, network: "Arc testnet (chain 5042002)" };
    expect(
      wellKnownKeyRefusal("AGENT_PRIVATE_KEY", ANVIL[1], { local: true, network: "the devchain" }),
    ).toBeNull();
    const refusal = wellKnownKeyRefusal("EXECUTOR_PRIVATE_KEY", ANVIL[2], arc);
    expect(refusal).toContain("EXECUTOR_PRIVATE_KEY");
    expect(refusal).toContain("Arc testnet (chain 5042002)");
    expect(refusal).not.toContain(ANVIL[2].slice(2, 12));
    expect(wellKnownKeyRefusal("AGENT_PRIVATE_KEY", generatePrivateKey(), arc)).toBeNull();
  });
});

describe("where a process signs", () => {
  it.each([
    ["http://127.0.0.1:8545", true, true],
    ["http://localhost:8545", true, true],
    ["http://[::1]:8545", true, true],
    ["http://anvil:8545", false, true],
    ["https://rpc.testnet.arc.io", false, false],
    ["https://anvil.example.quiknode.pro/key/", false, false],
    ["http://10.0.0.5:8545", false, false],
    // The WHATWG parser reads a bare number as an IPv4 address: this is 127.0.0.1.
    ["http://2130706433:8545", true, true],
    ["not a url", false, false],
  ])("%s: loopback %s, devchain deployment file %s", (url, loopback, devchain) => {
    expect(isLoopbackUrl(url)).toBe(loopback);
    expect(isDevchainRpc(url)).toBe(devchain);
  });
});
