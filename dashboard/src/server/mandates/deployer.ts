import "server-only";

import { PolicyClient, toSafeNumber } from "@mandate/shared";
import {
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  createWalletClient,
  getContractAddress,
  http,
  isAddressEqual,
  numberToHex,
  parseEther,
} from "viem";

import type { ContractKind } from "@/lib/live/types";

import { type MasterKey, ownerAccount } from "../accounts/keys";
import type { MandateContract } from "../accounts/store";
import { findDeployBlock } from "../ingest/chain-reader";
import { type PolicyArtifact, isPolicyRuntime } from "./artifact";

/**
 * How a new mandate gets its own Policy contract (#95). The contract's constructor makes its deployer the
 * `user()`, the owner, so who deploys decides who owns:
 *
 * - `server` (the demo chain): the console deploys from an owner key it made for the mandate and holds
 *   sealed; every later owner call is signed by the console after a member's passkey authorises it.
 * - `wallet` (Arc): the owner's own wallet deploys the bytecode the console serves; the console then
 *   checks the deployment and follows the contract.
 * - `factory` (not built): a factory contract the contract owner deploys once would create each Policy,
 *   so a smart account could own one. Its deployer would send `factory.create(agent, executor)` from the
 *   wallet and verify the factory's event instead of a creation transaction (docs/accounts.md).
 *
 * Every kind ends in `verifyDeployment`: the contract must be the compiled Policy, name this mandate's
 * agent and the expected executor, and its owner must be the one the kind promises.
 */
export interface DeployTarget {
  mandateId: string;
  /** The mandate's agent, which the contract must name. */
  agent: Address;
  /** The executor the contract must name: the one that serves every mandate. */
  executor: Address;
  /** The kind of the server's own contract: new mandates get the same. */
  kind: ContractKind;
}

export interface ChainAccess {
  client: PublicClient<Transport, Chain>;
  chain: Chain;
  rpcUrl: string;
}

/** What the owner's wallet sends to deploy a mandate's contract. */
export interface WalletDeployRequest {
  chainId: number;
  abi: Abi;
  bytecode: Hex;
  args: [Address, Address];
}

export class DeployError extends Error {
  override readonly name = "DeployError";
  constructor(
    readonly code:
      "not_policy" | "wrong_roles" | "not_deployed" | "wrong_chain" | "not_owner" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Checks a deployed contract and returns it as the mandate's contract. */
export async function verifyDeployment(
  access: ChainAccess,
  artifact: PolicyArtifact,
  target: DeployTarget,
  deployed: { address: Address; blockNumber: bigint; owner: Address },
): Promise<MandateContract> {
  const policy = new PolicyClient({ address: deployed.address, publicClient: access.client });
  const [code, roles] = await Promise.all([
    access.client.getCode({ address: deployed.address }),
    policy.getRoles().catch(() => null),
  ]);
  if (!code || code === "0x" || !roles) {
    throw new DeployError("not_policy", "No Policy contract is at that address.");
  }
  if (!isPolicyRuntime(artifact, code, roles.user)) {
    throw new DeployError(
      "not_policy",
      "The contract at that address is not the Policy contract this console serves, so it can't follow it.",
    );
  }
  if (!isAddressEqual(roles.user, deployed.owner)) {
    throw new DeployError("not_owner", "The contract's owner is not the account that deployed it.");
  }
  if (!isAddressEqual(roles.agent, target.agent) || !isAddressEqual(roles.executor, target.executor)) {
    throw new DeployError(
      "wrong_roles",
      "The contract names another agent or executor than this mandate's, so its trades would go nowhere.",
    );
  }
  return {
    chainId: access.chain.id,
    address: deployed.address,
    deployBlock: toSafeNumber(deployed.blockNumber, "deploy block"),
    kind: artifact.kind,
    executor: roles.executor,
    owner: roles.user,
  };
}

/** The wallet deployment the console asks for: the compiled contract and its two constructor arguments. */
export function walletDeployRequest(access: ChainAccess, artifact: PolicyArtifact, target: DeployTarget) {
  const request: WalletDeployRequest = {
    chainId: access.chain.id,
    abi: artifact.abi.filter((entry) => entry.type === "constructor"),
    bytecode: artifact.bytecode,
    args: [target.agent, target.executor],
  };
  return request;
}

/**
 * Checks the owner wallet's deployment: a successful transaction on this chain that created a contract,
 * sent by the account the contract names as its owner, which must be the compiled Policy with this
 * mandate's agent and the expected executor.
 */
export async function verifyWalletDeployment(
  access: ChainAccess,
  artifact: PolicyArtifact,
  target: DeployTarget,
  txHash: Hex,
): Promise<MandateContract> {
  let receipt;
  let transaction;
  try {
    [receipt, transaction] = await Promise.all([
      access.client.getTransactionReceipt({ hash: txHash }),
      access.client.getTransaction({ hash: txHash }),
    ]);
  } catch {
    throw new DeployError("not_deployed", "That transaction is not onchain yet. Try again in a few seconds.");
  }
  if (transaction.chainId !== undefined && transaction.chainId !== access.chain.id) {
    throw new DeployError("wrong_chain", "That transaction is on another chain.");
  }
  if (receipt.status !== "success" || transaction.to !== null || !receipt.contractAddress) {
    throw new DeployError("not_deployed", "That transaction did not deploy a contract.");
  }
  return verifyDeployment(access, artifact, target, {
    address: receipt.contractAddress,
    blockNumber: receipt.blockNumber,
    owner: receipt.from,
  });
}

/** Gas for a key the console made on the demo chain: anvil credits it, so no funded account is shared. */
const DEMO_BALANCE = parseEther("100");

/**
 * The demo chain's deployer: funds the mandate's owner key and agent key with anvil's `anvil_setBalance`
 * (the chain's own test faucet) and deploys from the owner key. The contract starts with no rules, so it
 * allows nothing; the first rules are an owner call like any other (`MandateManager.ownerCall`).
 *
 * The contract's address follows from the owner key and its first nonce, so a deployment that was sent
 * but not recorded is found again instead of being sent twice, and a demo chain that lost its state gets
 * the same contract at the same address.
 */
export async function deployFromServer(
  access: ChainAccess,
  artifact: PolicyArtifact,
  target: DeployTarget,
  owner: { master: MasterKey; key: { address: Address; sealed: string } },
): Promise<MandateContract> {
  const account = ownerAccount(owner.master, target.mandateId, owner.key);
  const address = getContractAddress({ from: account.address, nonce: 0n });
  const existing = await access.client.getCode({ address });
  if (existing && existing !== "0x") {
    const latest = await access.client.getBlockNumber({ cacheTime: 0 });
    const found = await findDeployBlock(access.client, address, latest);
    return verifyDeployment(access, artifact, target, {
      address,
      blockNumber: found,
      owner: account.address,
    });
  }
  const nonce = await access.client.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (nonce !== 0) {
    throw new DeployError(
      "unavailable",
      "This mandate's owner key has already sent transactions; ask the operator.",
    );
  }
  for (const funded of [account.address, target.agent]) {
    const balance = await access.client.getBalance({ address: funded });
    if (balance < DEMO_BALANCE / 2n) {
      await access.client.request({
        method: "anvil_setBalance" as never,
        params: [funded, numberToHex(DEMO_BALANCE)] as never,
      });
    }
  }
  const wallet = createWalletClient({ chain: access.chain, transport: http(access.rpcUrl), account });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [target.agent, target.executor],
    nonce: 0,
  });
  const receipt = await access.client.waitForTransactionReceipt({
    hash,
    pollingInterval: 100,
    timeout: 60_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new DeployError("not_deployed", "The deployment transaction failed.");
  }
  return verifyDeployment(access, artifact, target, {
    address: receipt.contractAddress,
    blockNumber: receipt.blockNumber,
    owner: account.address,
  });
}
