import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARC_TESTNET } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { resolveDeployment } from "./deployment";

const RECORD = {
  chainId: 5042002,
  contract: "reference",
  rpcUrl: "http://anvil:8545",
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  blockNumber: 1,
  user: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  executor: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  deployedAt: "2026-11-15T12:00:00.000Z",
};

function deploymentFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "console-deployment-")), "deployment.json");
  writeFileSync(path, JSON.stringify(RECORD));
  return path;
}

describe("resolveDeployment", () => {
  it("gives the browser the devchain's own RPC by default", () => {
    const resolution = resolveDeployment({ POLICY_DEPLOYMENT_FILE: deploymentFile() });
    expect(resolution.ok).toBe(true);
    expect(resolution.network).toMatchObject({ kind: "local", rpcUrl: "http://anvil:8545" });
  });

  it("gives the browser CONSOLE_BROWSER_RPC_URL for a devchain behind a proxy, and keeps the server's RPC", () => {
    const resolution = resolveDeployment({
      POLICY_DEPLOYMENT_FILE: deploymentFile(),
      CONSOLE_BROWSER_RPC_URL: " https://mandate.example/rpc ",
    });
    expect(resolution.network.rpcUrl).toBe("https://mandate.example/rpc");
    expect(resolution.ok && resolution.deployment.rpcUrl).toBe("http://anvil:8545");
  });

  it("ignores CONSOLE_BROWSER_RPC_URL on Arc testnet, where the browser uses Arc's public RPC", () => {
    const resolution = resolveDeployment({
      POLICY_ADDRESS: RECORD.address,
      ARC_RPC_URL: "https://provider.example/secret-key",
      CONSOLE_BROWSER_RPC_URL: "https://mandate.example/rpc",
    });
    expect(resolution.network).toMatchObject({ kind: "arc-testnet", rpcUrl: ARC_TESTNET.rpcUrl });
  });

  it("reports a CONSOLE_BROWSER_RPC_URL that is not an http(s) URL", () => {
    const resolution = resolveDeployment({
      POLICY_DEPLOYMENT_FILE: deploymentFile(),
      CONSOLE_BROWSER_RPC_URL: "anvil:8545",
    });
    expect(resolution).toMatchObject({
      ok: false,
      detail: expect.stringContaining("CONSOLE_BROWSER_RPC_URL must be an http(s) URL") as unknown,
    });
  });
});
