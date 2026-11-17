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

/** Who is signed in, as the layout hands it to the account menu. */
export interface AccountView {
  member: { name: string; role: "admin" | "viewer" };
  workspace: { name: string };
}
