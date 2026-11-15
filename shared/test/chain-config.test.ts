import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGwei } from "viem";
import {
  ARC_MIN_MAX_FEE_PER_GAS,
  ARC_TESTNET_CHAIN_ID,
  applyFeeFloor,
  arcTestnet,
  devchain,
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTxUrl,
  PolicyRevertError,
  revertErrorName,
  tradeIntentSchema,
  ZERO_HASH,
} from "../src";
import { DeploymentNotFoundError, resolvePolicyDeployment } from "../src/node";

const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TX = `0x${"ab".repeat(32)}` as const;

describe("chains", () => {
  it("defines Arc testnet with USDC gas and the devchain with the same id", () => {
    expect(arcTestnet.id).toBe(ARC_TESTNET_CHAIN_ID);
    expect(arcTestnet.id).toBe(5042002);
    expect(arcTestnet.nativeCurrency).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
    expect(arcTestnet.rpcUrls.default.http).toContain("https://rpc.testnet.arc.io");
    expect(devchain.id).toBe(5042002);
    expect(devchain.rpcUrls.default.http).toEqual(["http://127.0.0.1:8545"]);
  });

  it("builds explorer links, or null without an explorer", () => {
    expect(explorerTxUrl(arcTestnet, TX)).toBe(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(explorerAddressUrl(arcTestnet, ADDRESS)).toBe(
      `https://explorer.testnet.arc.io/address/${ADDRESS}`,
    );
    expect(explorerBlockUrl(arcTestnet, 12n)).toBe("https://explorer.testnet.arc.io/block/12");
    expect(explorerTxUrl(devchain, TX)).toBeNull();
  });
});

describe("applyFeeFloor", () => {
  it("raises the max fee to the 20 gwei Arc floor", () => {
    expect(ARC_MIN_MAX_FEE_PER_GAS).toBe(parseGwei("20"));
    expect(
      applyFeeFloor(
        { maxFeePerGas: parseGwei("2"), maxPriorityFeePerGas: parseGwei("1") },
        ARC_MIN_MAX_FEE_PER_GAS,
      ),
    ).toEqual({
      maxFeePerGas: parseGwei("20"),
      maxPriorityFeePerGas: parseGwei("1"),
    });
  });

  it("keeps higher estimates and caps the priority fee at the max fee", () => {
    const high = { maxFeePerGas: parseGwei("50"), maxPriorityFeePerGas: parseGwei("2") };
    expect(applyFeeFloor(high, ARC_MIN_MAX_FEE_PER_GAS)).toEqual(high);
    expect(applyFeeFloor({ maxFeePerGas: 1n, maxPriorityFeePerGas: 99n }, 10n)).toEqual({
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 10n,
    });
  });
});

describe("tradeIntentSchema", () => {
  const valid = {
    market: "GEMI-BTC2611202200-HI65000",
    category: 0,
    outcome: "YES",
    isBuy: true,
    amountCents: 1000,
    limitPrice: 65,
  };

  it("defaults the context hash to zero", () => {
    expect(tradeIntentSchema.parse(valid).contextHash).toBe(ZERO_HASH);
  });

  it("rejects malformed intents before they reach the chain", () => {
    for (const bad of [
      { ...valid, market: " " },
      { ...valid, category: 7 },
      { ...valid, outcome: "MAYBE" },
      { ...valid, amountCents: 0 },
      { ...valid, amountCents: 10.5 },
      { ...valid, limitPrice: 100 },
      { ...valid, limitPrice: 0 },
      { ...valid, contextHash: "0x12" },
    ]) {
      expect(tradeIntentSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("revertErrorName", () => {
  it("reads our revert error and ignores unrelated errors", () => {
    expect(revertErrorName(new PolicyRevertError("setPolicy", "NotOwner", new Error("x")))).toBe("NotOwner");
    expect(revertErrorName(new Error("boom"))).toBeNull();
    expect(revertErrorName("boom")).toBeNull();
  });
});

describe("resolvePolicyDeployment", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-deploy-"));
  const localPath = join(dir, "local.json");
  const missingPath = join(dir, "missing.json");

  it("prefers POLICY_ADDRESS on Arc testnet", () => {
    const resolved = resolvePolicyDeployment({
      env: {
        POLICY_ADDRESS: ADDRESS,
        ARC_RPC_URL: "https://example.invalid/rpc",
        POLICY_DEPLOY_BLOCK: "123",
      },
      localPath: missingPath,
    });
    expect(resolved).toMatchObject({
      source: "env",
      address: ADDRESS,
      rpcUrl: "https://example.invalid/rpc",
      fromBlock: 123n,
      local: null,
    });
    expect(resolved.chain.id).toBe(5042002);
    expect(resolvePolicyDeployment({ env: { POLICY_ADDRESS: ADDRESS }, localPath: missingPath }).rpcUrl).toBe(
      "https://rpc.testnet.arc.io",
    );
  });

  it("falls back to the devchain deployment file", () => {
    writeFileSync(
      localPath,
      JSON.stringify({
        chainId: 5042002,
        rpcUrl: "http://127.0.0.1:8545",
        address: ADDRESS,
        blockNumber: 1,
        owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        executor: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        deployedAt: "2026-11-15T12:00:00.000Z",
      }),
    );
    const resolved = resolvePolicyDeployment({ env: { POLICY_ADDRESS: "  " }, localPath });
    expect(resolved).toMatchObject({
      source: "devchain",
      address: ADDRESS,
      fromBlock: 1n,
      rpcUrl: "http://127.0.0.1:8545",
    });
    expect(resolved.chain.rpcUrls.default.http).toEqual(["http://127.0.0.1:8545"]);
  });

  it("explains what to do when nothing is configured or values are invalid", () => {
    expect(() => resolvePolicyDeployment({ env: {}, localPath: missingPath })).toThrow(/npm run dev:chain/);
    expect(() => resolvePolicyDeployment({ env: { POLICY_ADDRESS: "0x123" }, localPath })).toThrow(
      DeploymentNotFoundError,
    );
    expect(() =>
      resolvePolicyDeployment({ env: { POLICY_ADDRESS: ADDRESS, POLICY_DEPLOY_BLOCK: "latest" }, localPath }),
    ).toThrow(DeploymentNotFoundError);
  });
});
