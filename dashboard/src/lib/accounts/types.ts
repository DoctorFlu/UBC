import type { Address } from "viem";

/** An agent token as the console lists it: never the token, never its hash. */
export interface AgentTokenView {
  id: string;
  agentId: string;
  name: string;
  /** `env`: the server's `MCP_AUTH_TOKEN`, registered the first time it was used. */
  source: "console" | "env";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  /** Null for the server's own agent, whose address the MCP server reports when it pairs. */
  address: Address | null;
  mandate: { id: string; name: string; hasContract: boolean };
  /** Live tokens first, then newest first. */
  tokens: AgentTokenView[];
}

/** GET /api/console/agents */
export interface AgentsResponse {
  /** Where Grok Bot reaches the MCP server, when configured. */
  mcpUrl: string | null;
  agents: AgentView[];
}

/** POST /api/console/agents/:agentId/tokens: the only answer that ever carries the token. */
export interface CreatedToken {
  token: string;
  view: AgentTokenView;
}

/** A mandate as the switcher, Home and Setup show it (#95). */
export interface MandateView {
  id: string;
  name: string;
  /**
   * Where its contract came from: `env`, the server's; `server`, deployed by the console on the demo chain;
   * `wallet`, by the owner's wallet; null, none yet.
   */
  deployment: "env" | "server" | "wallet" | null;
  contract: { chainId: number; address: Address } | null;
  /** Who signs owner calls: the owner's `wallet`, or the `console` after a passkey; null without a contract. */
  ownerSigner: "wallet" | "console" | null;
  agent: { id: string; address: Address | null };
  createdAt: string;
}

/** GET /api/console/mandates */
export interface MandatesResponse {
  /** Who deploys a new mandate's contract here: the `server` (demo chain), the owner's `wallet` (Arc). */
  deployer: "server" | "wallet" | null;
  /** Most mandates this workspace may have. */
  limit: number;
  mandates: MandateView[];
}

/** POST /api/console/mandates: the new mandate, with its agent's first token, shown this once. */
export interface CreatedMandateResponse {
  mandate: MandateView;
  token: CreatedToken;
  /** Why the console's deployment failed, when it did: the mandate exists with no contract yet. */
  deployProblem: string | null;
  mcpUrl: string | null;
}

/** GET /api/console/mandates/:id/deployment: what the owner's wallet sends to deploy the contract. */
export interface WalletDeployView {
  chainId: number;
  abi: readonly unknown[];
  bytecode: `0x${string}`;
  args: [Address, Address];
}

/** Who is signed in, as the layout hands it to the account menu. */
export interface AccountView {
  member: { name: string; role: "admin" | "viewer" };
  workspace: { name: string };
}
