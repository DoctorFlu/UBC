import type { Abi, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { type PolicyArtifact, isPolicyRuntime } from "./artifact";

const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const word = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
const runtime = `0x6080${"00".repeat(32)}5b00` as Hex;

const artifactOf = (immutables: PolicyArtifact["immutables"]): PolicyArtifact => ({
  kind: "production",
  abi: [] as Abi,
  bytecode: "0x00",
  runtime,
  immutables,
});

describe("isPolicyRuntime", () => {
  describe("a contract without immutables (production: its user is storage)", () => {
    const artifact = artifactOf([]);

    it("accepts exactly the compiled runtime, whoever its user is", () => {
      expect(isPolicyRuntime(artifact, runtime, USER)).toBe(true);
    });

    it("refuses one byte changed, a longer or shorter code, and no code", () => {
      expect(isPolicyRuntime(artifact, `0x6081${"00".repeat(32)}5b00`, USER)).toBe(false);
      expect(isPolicyRuntime(artifact, `${runtime}00`, USER)).toBe(false);
      expect(isPolicyRuntime(artifact, runtime.slice(0, -2) as Hex, USER)).toBe(false);
      expect(isPolicyRuntime(artifactOf([]), "0x", USER)).toBe(false);
    });
  });

  describe("a contract with `user` as its immutable (the devchain reference)", () => {
    const artifact = artifactOf([{ start: 2, length: 32 }]);
    const deployed = (address: string) => `0x6080${word(address)}5b00` as Hex;

    it("accepts the compiled runtime with the user in the slot", () => {
      expect(isPolicyRuntime(artifact, deployed(USER), USER)).toBe(true);
    });

    it("refuses another address in the slot, or a byte changed outside it", () => {
      expect(isPolicyRuntime(artifact, deployed(OTHER), USER)).toBe(false);
      expect(isPolicyRuntime(artifact, `0x6080${word(USER)}5b01`, USER)).toBe(false);
    });
  });
});
