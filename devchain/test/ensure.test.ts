import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { deploymentFileSchema, devchain } from "@mandate/shared";
import { DEMO_POLICY, devPolicyClient, ensureDeployment, startAnvil, type AnvilInstance } from "../src";

let anvil: AnvilInstance;
let other: AnvilInstance;

beforeAll(async () => {
  [anvil, other] = await Promise.all([startAnvil({ port: 0 }), startAnvil({ port: 0, chainId: 31337 })]);
});

afterAll(async () => {
  await Promise.all([anvil.stop(), other.stop()]);
});

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ensure-deployment-")), "deployment.json");
}

function readRecord(path: string) {
  return deploymentFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

describe("ensureDeployment", () => {
  it("deploys with the demo rules once, then reuses the deployment", async () => {
    const path = freshPath();
    const first = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "reference", path });
    expect(first).toMatchObject({ action: "deployed", reason: "there is no deployment file yet" });
    expect(readRecord(path)).toEqual(first.record);
    expect(first.record).toMatchObject({ contract: "reference", rpcUrl: anvil.rpcUrl, chainId: 5042002 });
    const rules = await devPolicyClient(anvil.rpcUrl, first.record.address, "user").getRules();
    expect(rules).toEqual(DEMO_POLICY);

    const second = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "reference", path });
    expect(second).toEqual({ action: "reused", record: first.record });
  });

  it("deploys again when the chain no longer has the recorded contract", async () => {
    const path = freshPath();
    const first = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "reference", path });
    // What a lost anvil state looks like from the file's side: an address with no code behind it.
    const stale = { ...first.record, address: "0x000000000000000000000000000000000000dEaD" };
    writeFileSync(path, JSON.stringify(stale));
    const again = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "reference", path });
    if (again.action !== "deployed") throw new Error("expected a new deployment");
    expect(again.reason).toMatch(/no contract at 0x0+dEaD/);
    const client = createPublicClient({ chain: devchain, transport: http(anvil.rpcUrl) });
    expect(await client.getCode({ address: again.record.address })).toBeDefined();
    expect(readRecord(path).address).toBe(again.record.address);
  });

  it("deploys again for another contract kind or an unreadable file", async () => {
    const path = freshPath();
    await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "reference", path });
    const production = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "production", path });
    expect(production).toMatchObject({
      action: "deployed",
      reason: "the deployment file holds the reference contract, not the production one",
    });

    writeFileSync(path, "{ not json");
    const repaired = await ensureDeployment({ rpcUrl: anvil.rpcUrl, contract: "production", path });
    expect(repaired).toMatchObject({ action: "deployed", reason: "the deployment file could not be read" });
    expect(readRecord(path)).toEqual(repaired.record);
  });

  it("refuses a chain without Arc's chain id", async () => {
    await expect(
      ensureDeployment({ rpcUrl: other.rpcUrl, contract: "reference", path: freshPath() }),
    ).rejects.toThrow(/chain id 31337, not Arc's 5042002/);
  });
});
