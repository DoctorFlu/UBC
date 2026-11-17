import { encodeFunctionData, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type AgentSigner,
  agentTransactionRefusal,
  fromUnsignedTransaction,
  hashAgentToken,
  policyAbi,
  resolveTokenResponseSchema,
  signerAccount,
  toUnsignedTransaction,
} from "../src";

const POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const propose = encodeFunctionData({
  abi: policyAbi,
  functionName: "proposeTrade",
  args: ["GEMI-BTC2611202200-HI65000", 1, "NO", true, 1_000n, 31n],
});

function tx(overrides: Partial<ReturnType<typeof toUnsignedTransaction>> = {}) {
  return {
    ...toUnsignedTransaction({
      type: "eip1559",
      chainId: 5042002,
      nonce: 3,
      to: POLICY,
      data: propose,
      gas: 200_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1n,
    }),
    ...overrides,
  };
}

describe("agent tokens", () => {
  it("hashes a token to 64 lowercase hex digits, the same every time", () => {
    const hash = hashAgentToken("mdt_example");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken("mdt_example")).toBe(hash);
    expect(hashAgentToken("mdt_examplf")).not.toBe(hash);
  });

  it("accepts the env agent and generated agent ids only", () => {
    const base = {
      workspaceId: "wsp_1",
      mandateId: "mnd_1",
      tokenId: "tok_1",
      agent: { address: null, signer: "env" },
      mandate: { deployment: "env" },
    };
    expect(resolveTokenResponseSchema.safeParse({ ...base, agentId: "env" }).success).toBe(true);
    expect(
      resolveTokenResponseSchema.safeParse({ ...base, agentId: "agt_0123456789abcdefghjkmnpqrs" }).success,
    ).toBe(true);
    expect(resolveTokenResponseSchema.safeParse({ ...base, agentId: "agt_../../x" }).success).toBe(false);
  });
});

describe("what an agent key may sign", () => {
  const mandate = { policyAddress: POLICY, chainId: 5042002 } as const;

  it("signs a proposal to its own contract on its own chain", () => {
    expect(agentTransactionRefusal(tx(), mandate)).toBeNull();
    const withContext = encodeFunctionData({
      abi: policyAbi,
      functionName: "proposeTrade",
      args: ["GEMI-BTC2611202200-HI65000", 1, "NO", true, 1_000n, 31n, `0x${"ab".repeat(32)}`],
    });
    expect(agentTransactionRefusal(tx({ data: withContext }), mandate)).toBeNull();
  });

  it("refuses another contract, another chain, value, owner calls and plain transfers", () => {
    expect(agentTransactionRefusal(tx({ to: OTHER }), mandate)).toMatch(/Policy contract/);
    expect(agentTransactionRefusal(tx({ chainId: 1 }), mandate)).toMatch(/another chain/);
    expect(agentTransactionRefusal(tx({ value: "1" }), mandate)).toMatch(/value/);
    const pause = encodeFunctionData({ abi: policyAbi, functionName: "setPaused", args: [false] });
    expect(agentTransactionRefusal(tx({ data: pause }), mandate)).toMatch(
      /only proposes trades, not setPaused/,
    );
    expect(agentTransactionRefusal(tx({ data: "0x" }), mandate)).toMatch(/does not call/);
  });

  it("round-trips a transaction through its wire shape", () => {
    const wire = tx();
    expect(toUnsignedTransaction(fromUnsignedTransaction(wire))).toEqual(wire);
  });
});

describe("signerAccount", () => {
  const key = privateKeyToAccount(KEY);
  const signer: AgentSigner = {
    address: key.address,
    signTransaction: (transaction) => key.signTransaction(transaction),
  };

  it("signs transactions through the signer, recoverable to its address", async () => {
    const account = signerAccount(signer);
    const signed = await account.signTransaction(fromUnsignedTransaction(tx()));
    expect(parseTransaction(signed).to?.toLowerCase()).toBe(POLICY.toLowerCase());
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(key.address);
  });

  it("never signs a message or typed data", async () => {
    const account = signerAccount(signer);
    await expect(account.signMessage({ message: "hello" })).rejects.toThrow(/transactions only/);
  });
});
