import { afterAll, describe, expect, it } from "vitest";
import { clientOrderIdFor } from "@mandate/shared";
import { deployPolicy, devPolicyClient, startAnvil, venueDeployment, type AnvilInstance } from "../src";
import { GENESIS_TIMESTAMP } from "./harness";

const started: AnvilInstance[] = [];

afterAll(async () => {
  await Promise.all(started.map((anvil) => anvil.stop()));
});

/** A fresh dev chain started at `genesis`, with the Policy contract deployed as the dev stack does. */
async function freshStack(genesis: number) {
  const anvil = await startAnvil({ port: 0, timestamp: genesis });
  started.push(anvil);
  const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract: "production" });
  const client = devPolicyClient(anvil.rpcUrl, deployment.address, "executor");
  return { address: deployment.address, ids: await venueDeployment(client, deployment.blockNumber) };
}

describe("client order ids across deployments (#117)", () => {
  it("differ between two stacks that deploy the contract at the same address", async () => {
    // The second stack starts a second later, as a restarted dev stack always does.
    const first = await freshStack(GENESIS_TIMESTAMP);
    const second = await freshStack(GENESIS_TIMESTAMP + 1);
    expect(second.address).toBe(first.address);
    expect(second.ids.policy).toBe(first.ids.policy);
    expect(second.ids.deployBlockHash).not.toBe(first.ids.deployBlockHash);
    expect(clientOrderIdFor(second.ids, 0)).not.toBe(clientOrderIdFor(first.ids, 0));
    expect(clientOrderIdFor(first.ids, 0)).toMatch(/^mandate-5042002-[0-9a-f]{8}-[0-9a-f]{12}-0$/);
  });
});
