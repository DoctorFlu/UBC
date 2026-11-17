import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { applyDeploymentFile } from "../src/deployment-file";
import { TEST_POLICY, TEST_TOKEN, testConfig } from "./helpers";

const RECORD = {
  chainId: 5042002,
  contract: "reference",
  rpcUrl: "http://anvil:8545",
  address: TEST_POLICY,
  blockNumber: 7,
  user: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  executor: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  deployedAt: "2026-11-15T12:00:00.000Z",
};

function deploymentFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "mcp-deployment-")), "deployment.json");
  writeFileSync(path, content);
  return path;
}

describe("applyDeploymentFile", () => {
  it("leaves the environment alone without POLICY_DEPLOYMENT_FILE", () => {
    const env = { MCP_AUTH_TOKEN: TEST_TOKEN, ARC_RPC_URL: "https://rpc.example" };
    expect(applyDeploymentFile(env)).toBe(env);
  });

  it("lets POLICY_ADDRESS win over the file, as every other package does", () => {
    const env = { POLICY_ADDRESS: TEST_POLICY, POLICY_DEPLOYMENT_FILE: "/does/not/exist.json" };
    expect(applyDeploymentFile(env)).toBe(env);
  });

  it("takes the address, deploy block and RPC from the file, over ARC_RPC_URL", () => {
    const path = deploymentFile(JSON.stringify(RECORD));
    const env = applyDeploymentFile({
      POLICY_DEPLOYMENT_FILE: path,
      POLICY_ADDRESS: " ",
      ARC_RPC_URL: "https://rpc.testnet.arc.io",
    });
    expect(env).toMatchObject({
      POLICY_ADDRESS: TEST_POLICY,
      POLICY_DEPLOY_BLOCK: "7",
      ARC_RPC_URL: "http://anvil:8545",
    });
    const config = testConfig(env as Record<string, string>);
    expect(config.policyAddress).toBe(TEST_POLICY);
    expect(config.policyDeployBlock).toBe(7n);
  });

  it("lets anvil's agent key sign on the hosted demo chain http://anvil:8545 the file names, and nowhere else", () => {
    const anvilAgent = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const path = deploymentFile(JSON.stringify(RECORD));
    // The hosted demo reaches anvil by its container name: not a loopback address, still the devchain.
    const env = applyDeploymentFile({ POLICY_DEPLOYMENT_FILE: path, AGENT_PRIVATE_KEY: anvilAgent });
    expect(testConfig(env as Record<string, string>).agentAddress).toBe(RECORD.agent);
    // The same address typed in by hand is not the devchain's file.
    expect(() =>
      testConfig({
        AGENT_PRIVATE_KEY: anvilAgent,
        POLICY_ADDRESS: TEST_POLICY,
        ARC_RPC_URL: "http://anvil:8545",
      }),
    ).toThrow(ConfigError);
    // A hand-written file that names Arc testnet is not the devchain's, whatever it claims.
    for (const rpcUrl of [
      "https://rpc.testnet.arc.io",
      "https://anvil.example.quiknode.pro/key/",
      "http://10.0.0.5:8545",
    ]) {
      const arcFile = deploymentFile(JSON.stringify({ ...RECORD, rpcUrl }));
      const arcEnv = applyDeploymentFile({ POLICY_DEPLOYMENT_FILE: arcFile, AGENT_PRIVATE_KEY: anvilAgent });
      expect(() => testConfig(arcEnv as Record<string, string>)).toThrow(ConfigError);
    }
  });

  it("names the variable and the path when the file is missing", () => {
    expect(() => applyDeploymentFile({ POLICY_DEPLOYMENT_FILE: "/no/such/deployment.json" })).toThrow(
      ConfigError,
    );
    try {
      applyDeploymentFile({ POLICY_DEPLOYMENT_FILE: "/no/such/deployment.json" });
    } catch (error) {
      expect((error as ConfigError).problems).toEqual([
        expect.stringMatching(/^POLICY_DEPLOYMENT_FILE: \/no\/such\/deployment\.json is not a usable/),
      ]);
    }
  });

  it("refuses a file that is not a deployment record", () => {
    const path = deploymentFile(JSON.stringify({ ...RECORD, address: "0x1234" }));
    expect(() => applyDeploymentFile({ POLICY_DEPLOYMENT_FILE: path })).toThrow(ConfigError);
  });
});
