import "server-only";

import { PolicyClient, type PolicyRules, policyAbi, revertErrorName, signerAccount } from "@mandate/shared";
import {
  type Address,
  BaseError,
  type Hex,
  createWalletClient,
  http,
  isAddressEqual,
  numberToHex,
  parseEther,
} from "viem";

import type { ContractKind } from "@/lib/live/types";
import { type OwnerCall, encodeOwnerCall } from "@/lib/owner/calls";

import { AccountError, type Access } from "../accounts/accounts";
import { localOwnerSigner } from "../accounts/keys";
import type { Agent, AgentTokenView, Mandate } from "../accounts/store";
import type { ConsoleService } from "../console-service";
import { errorMessage } from "../follower";
import { type PolicyArtifact, artifactsDir, loadPolicyArtifact } from "./artifact";
import {
  type ChainAccess,
  DeployError,
  type DeployTarget,
  type WalletDeployRequest,
  deployFromServer,
  verifyWalletDeployment,
  walletDeployRequest,
} from "./deployer";

/** What creating a mandate made: the mandate, its agent and the agent's first token, shown this once. */
export interface CreatedMandate {
  mandate: Mandate;
  agent: Agent;
  token: { token: string; view: AgentTokenView };
  /** Why the console's deployment failed, when it did; the mandate exists, with no contract yet. */
  deployProblem: string | null;
}

/** The name the first token gets: the app the connect steps set up. */
export const FIRST_TOKEN_NAME = "Grok Bot";

/** Below this, the console tops up an owner key it holds on the demo chain before sending. */
const LOW_BALANCE = parseEther("1");
const TOP_UP = parseEther("100");

/**
 * Several mandates per workspace (#95): creating one under the workspace's cap, deploying its contract
 * (the console on the demo chain, the owner's wallet on Arc, see `deployer.ts`), and the owner calls the
 * console signs for a contract it deployed, which `StepUp` authorises first.
 */
export class MandateManager {
  readonly #deploying = new Set<string>();
  #warnedDeployer = false;
  /** One owner client per mandate, so its writes are serialized and never race for a nonce. */
  readonly #ownerClients = new Map<string, PolicyClient>();

  constructor(private readonly service: ConsoleService) {}

  /** Who deploys a new mandate's contract here, or null while the console reads no chain. */
  deployer(): "server" | "wallet" | null {
    const session = this.service.serverContract;
    if (!session) return null;
    const local = session.network.kind === "local";
    const configured = this.service.config.mandates.deployer;
    if (configured === "server" && !local) {
      // The console holding owner keys, funded from the chain's own faucet, is for the demo chain only.
      if (!this.#warnedDeployer) {
        this.#warnedDeployer = true;
        this.service.log.warn(
          "CONSOLE_MANDATE_DEPLOYER=server is for the demo chain only; new mandates are off until it is removed.",
        );
      }
      return null;
    }
    return configured ?? (local ? "server" : "wallet");
  }

  /** The chain every mandate's contract is on: the server's own contract's. */
  chainAccess(): ChainAccess | null {
    const session = this.service.serverContract;
    if (!session) return null;
    return { client: session.client, chain: session.deployment.chain, rpcUrl: session.deployment.rpcUrl };
  }

  /** The compiled contract new mandates get: the same kind as the server's own. */
  artifact(): PolicyArtifact | null {
    const kind: ContractKind = this.service.serverContract?.kind ?? "production";
    return loadPolicyArtifact(artifactsDir(this.service.config.mandates.artifactsDir), kind);
  }

  /** What a mandate's contract must name: its agent, and the executor that serves every mandate. */
  async target(mandate: Mandate): Promise<DeployTarget | null> {
    const agent = this.service.accounts.store.agentOf(mandate.id);
    if (agent.address === null) return null;
    const executor: Address | null =
      this.service.config.mandates.executor ?? (await this.service.serverRoles())?.executor ?? null;
    if (executor === null) return null;
    return {
      mandateId: mandate.id,
      agent: agent.address,
      executor,
      kind: this.service.serverContract?.kind ?? "production",
    };
  }

  /**
   * Creates a mandate in the member's workspace, with its agent and a first token, and on the demo chain
   * deploys its contract with `rules`. Refused past the workspace's cap, checked where the mandate is
   * written. A failed deployment leaves the mandate without a contract, to deploy again from Setup.
   */
  async create(
    access: Access,
    input: { name: string; rules: PolicyRules | null; credentialId: string | null },
  ): Promise<CreatedMandate> {
    const deployer = this.deployer();
    if (deployer === null) {
      throw new AccountError(
        503,
        "chain_unavailable",
        "The console can't read the chain right now. Try again shortly.",
      );
    }
    const { maxPerWorkspace } = this.service.config.mandates;
    const created = this.service.accounts.store.createMandate({
      workspaceId: access.workspace.id,
      name: input.name,
      master: this.service.accounts.master,
      maxPerWorkspace,
      ownerKey: deployer === "server",
    });
    if (!created.ok) {
      throw new AccountError(
        409,
        "mandate_limit",
        `This workspace has ${String(created.count)} mandates, the most this console allows (${String(maxPerWorkspace)}). ` +
          "Ask the operator to raise CONSOLE_MANDATES_PER_WORKSPACE.",
      );
    }
    const token = this.service.accounts.store.createToken(created.agent.id, FIRST_TOKEN_NAME);
    this.service.accounts.store.recordOwnerAction({
      mandateId: created.mandate.id,
      memberId: access.member.id,
      credentialId: input.credentialId,
      functionName: "mandate.create",
      calldata: null,
      status: "sent",
      txHash: null,
      detail: `${input.name}, with its agent's first token (${token.view.id})`,
    });
    let deployProblem: string | null = null;
    let mandate = created.mandate;
    if (deployer === "server") {
      try {
        mandate = await this.deployFromServer(mandate);
      } catch (error) {
        deployProblem = describeDeployFailure(error);
      }
      if (deployProblem === null && input.rules) {
        // The first rules, as the passkey that confirmed this creation authorised them, recorded with it.
        try {
          await this.ownerCall(
            access,
            mandate,
            { functionName: "setPolicy", rules: input.rules },
            input.credentialId,
          );
        } catch (error) {
          deployProblem = `The contract is deployed, but its first rules were not set: ${errorMessage(error)}`;
        }
      }
    }
    this.service.changed(mandate.id);
    return { mandate, agent: created.agent, token, deployProblem };
  }

  /** Deploys a mandate's contract from the owner key the console holds for it (the demo chain). */
  async deployFromServer(mandate: Mandate): Promise<Mandate> {
    if (mandate.contract) return mandate;
    if (this.deployer() !== "server") {
      throw new DeployError("unavailable", "Here the owner's wallet deploys each mandate's contract.");
    }
    const key = this.service.accounts.store.ensureOwnerKey(mandate.id, this.service.accounts.master);
    if (!key) throw new DeployError("not_owner", "The console holds no owner key for this mandate.");
    if (this.#deploying.has(mandate.id)) {
      throw new DeployError("unavailable", "This mandate's contract is being deployed already.");
    }
    this.#deploying.add(mandate.id);
    try {
      const [access, artifact, target] = [this.chainAccess(), this.artifact(), await this.target(mandate)];
      if (!access || !target)
        throw new DeployError("unavailable", "The console can't read the chain right now.");
      if (!artifact) {
        throw new DeployError("unavailable", "The compiled Policy contract is missing; ask the operator.");
      }
      const contract = await deployFromServer(access, artifact, target, {
        master: this.service.accounts.master,
        key,
      });
      const attached = this.service.accounts.store.attachContract(mandate.id, "server", contract);
      if (!attached) throw new DeployError("unavailable", "Another mandate already follows that contract.");
      this.service.refreshFollowers();
      return attached;
    } finally {
      this.#deploying.delete(mandate.id);
    }
  }

  /** What the owner's wallet sends to deploy this mandate's contract (Arc), or null when it cannot yet. */
  async walletRequest(mandate: Mandate): Promise<WalletDeployRequest | null> {
    const [access, artifact, target] = [this.chainAccess(), this.artifact(), await this.target(mandate)];
    if (!access || !artifact || !target) return null;
    return walletDeployRequest(access, artifact, target);
  }

  /** Checks the owner wallet's deployment transaction and gives the mandate that contract. */
  async attachWalletDeployment(mandate: Mandate, txHash: Hex): Promise<Mandate> {
    if (mandate.contract) {
      throw new AccountError(409, "has_contract", "This mandate already has its contract.");
    }
    if (this.deployer() !== "wallet" || this.service.accounts.store.ownerKeyOf(mandate.id)) {
      throw new AccountError(409, "server_deployed", "The console deploys this mandate's contract itself.");
    }
    const [access, artifact, target] = [this.chainAccess(), this.artifact(), await this.target(mandate)];
    if (!access || !artifact || !target) {
      throw new AccountError(
        503,
        "chain_unavailable",
        "The console can't read the chain right now. Try again shortly.",
      );
    }
    let contract;
    try {
      contract = await verifyWalletDeployment(access, artifact, target, txHash);
    } catch (error) {
      if (error instanceof DeployError) throw new AccountError(422, error.code, error.message);
      throw error;
    }
    const attached = this.service.accounts.store.attachContract(mandate.id, "wallet", contract);
    if (!attached) {
      throw new AccountError(409, "contract_taken", "Another mandate already follows that contract.");
    }
    this.service.refreshFollowers();
    this.service.changed(mandate.id);
    return attached;
  }

  /**
   * Signs and sends an owner call with the owner key the console holds for `mandate`, and records who
   * authorised it with which passkey. The caller has already checked the authority (`StepUp`, or a
   * session alone for a pause). The call is simulated first, so a refusal names the contract's reason.
   *
   * The contract's owner can hand the contract to another account (`setUser`). The console checks that its
   * key is still `user()`, read now, before it spends anything on the call, and refuses with who the owner
   * is otherwise: from then on only that account can act, and the console's pages say so.
   */
  async ownerCall(
    access: Access,
    mandate: Mandate,
    call: OwnerCall,
    credentialId: string | null,
  ): Promise<{ hash: Hex }> {
    const key = this.service.accounts.store.ownerKeyOf(mandate.id);
    const contract = mandate.contract;
    const chain = this.chainAccess();
    if (mandate.deployment !== "server" || !key || !contract) {
      throw new AccountError(409, "not_console_owned", "The console does not hold this mandate's owner key.");
    }
    if (!chain) {
      throw new AccountError(
        503,
        "chain_unavailable",
        "The console can't read the chain right now. Try again shortly.",
      );
    }
    let owner: Address;
    try {
      owner = await chain.client.readContract({
        address: contract.address,
        abi: policyAbi,
        functionName: "user",
      });
    } catch {
      throw new AccountError(
        503,
        "chain_unavailable",
        "The console can't read the contract's owner right now. Try again shortly.",
      );
    }
    if (!isAddressEqual(owner, key.address)) {
      throw new AccountError(
        409,
        "owner_changed",
        `This contract's owner is now ${owner}, not the key the console holds for this mandate, so only that account can act as the owner.`,
      );
    }
    const calldata = encodeOwnerCall(call);
    const record = (status: "sent" | "failed", hash: Hex | null, detail: string | null) =>
      this.service.accounts.store.recordOwnerAction({
        mandateId: mandate.id,
        memberId: access.member.id,
        credentialId,
        functionName: call.functionName,
        calldata,
        status,
        txHash: hash,
        detail,
      });
    try {
      await this.topUp(chain, key.address);
      const client = this.ownerClient(mandate, chain, key);
      let result;
      switch (call.functionName) {
        case "setPolicy":
          result = await client.setPolicy(call.rules);
          break;
        case "setPaused":
          result = await client.setPaused(call.paused);
          break;
        case "approveIntent":
          result = await client.approveIntent(call.intentId);
          break;
        case "rejectIntent":
          result = await client.rejectIntent(call.intentId);
          break;
      }
      record("sent", result.txHash, null);
      return { hash: result.txHash };
    } catch (error) {
      const detail = describeCallFailure(error);
      record("failed", null, detail);
      throw new AccountError(409, "call_refused", detail);
    }
  }

  private ownerClient(
    mandate: Mandate,
    chain: ChainAccess,
    key: { address: Address; sealed: string },
  ): PolicyClient {
    const contract = mandate.contract;
    if (!contract) throw new Error("no contract");
    const cached = this.#ownerClients.get(mandate.id);
    if (cached && cached.address === contract.address) return cached;
    const account = signerAccount(localOwnerSigner(this.service.accounts.master, mandate.id, key));
    const client = new PolicyClient({
      address: contract.address,
      publicClient: chain.client,
      walletClient: createWalletClient({ chain: chain.chain, transport: http(chain.rpcUrl), account }),
      minMaxFeePerGas: 0n,
      receiptPollingMs: 100,
      receiptTimeoutMs: 60_000,
    });
    this.#ownerClients.set(mandate.id, client);
    return client;
  }

  /** On the demo chain an owner key the console holds never runs dry: anvil credits it. */
  private async topUp(chain: ChainAccess, address: Address): Promise<void> {
    if (this.service.serverContract?.network.kind !== "local") return;
    const balance = await chain.client.getBalance({ address });
    if (balance >= LOW_BALANCE) return;
    await chain.client.request({
      method: "anvil_setBalance" as never,
      params: [address, numberToHex(TOP_UP)] as never,
    });
  }
}

const REVERTS: Record<string, string> = {
  NotUser: "The contract refused: the console's key is not this contract's owner.",
  WrongStatus: "That intent was already decided, so there is nothing left to sign.",
};

function describeCallFailure(error: unknown): string {
  const name = revertErrorName(error);
  if (name) return REVERTS[name] ?? `The contract refused the call (${name}).`;
  if (error instanceof BaseError) return error.shortMessage;
  return errorMessage(error);
}

function describeDeployFailure(error: unknown): string {
  if (error instanceof DeployError) return error.message;
  return `The deployment failed: ${errorMessage(error)}.`;
}
