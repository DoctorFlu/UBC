import "server-only";

import { type Address, type Hex, getAddress } from "viem";

import { ENV_AGENT_ID } from "@mandate/shared";

import { type Database, transaction } from "../db";
import { type MasterKey, createSealedAgentKey, createSealedOwnerKey } from "./keys";
import { hashSecret, newAgentToken, newId } from "./secrets";

/**
 * Workspaces, members, passkeys, sessions, mandates, agents and agent tokens (docs/accounts.md). Every
 * secret is stored as its SHA-256 only; nothing here returns a hash to a caller that does not already
 * hold the secret.
 */

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  claimedAt: string | null;
}

export interface Member {
  id: string;
  workspaceId: string;
  name: string;
  role: "admin" | "viewer";
  /** The WebAuthn user handle, base64url. Not a secret. */
  webauthnUserId: string;
  createdAt: string;
}

/**
 * Where a mandate's Policy contract came from:
 * - `env`: the contract the server is configured with (the first workspace's first mandate);
 * - `server`: deployed by the console on the demo chain, from an owner key the console holds;
 * - `wallet`: deployed by the owner's own wallet, then checked by the console;
 * - null: no contract yet.
 */
export type MandateDeployment = "env" | "server" | "wallet";

/** A contract a mandate has of its own (`server` or `wallet`); the `env` one comes from the settings. */
export interface MandateContract {
  chainId: number;
  address: Address;
  deployBlock: number;
  kind: "production" | "reference";
  /** The executor the contract was deployed with. */
  executor: Address;
  /** The contract's `user()`: the console's sealed key for `server`, the owner's wallet for `wallet`. */
  owner: Address;
}

export interface Mandate {
  id: string;
  workspaceId: string;
  name: string;
  deployment: MandateDeployment | null;
  contract: MandateContract | null;
  /**
   * The address of the owner key the console holds for this mandate, when it holds one: a `server`
   * deployment, or a mandate whose server deployment has not finished. The key itself is only ever read
   * through `ownerKeyOf`.
   */
  ownerKeyAddress: Address | null;
  createdAt: string;
}

/** An owner call the console signed for a member, as the audit trail shows it. */
export interface OwnerActionRecord {
  id: string;
  mandateId: string;
  memberId: string;
  memberName: string | null;
  /** The passkey that authorised it; null for a pause, which a session alone may do. */
  credentialId: string | null;
  functionName: string;
  calldata: Hex;
  status: "sent" | "failed";
  txHash: Hex | null;
  detail: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  mandateId: string;
  name: string;
  signer: "env" | "console";
  /** Null for the server's own key, whose address only the MCP server knows. */
  address: Address | null;
  /** The sealed private key (`keys.ts`); null for the server's own key. */
  sealedKey: string | null;
  createdAt: string;
}

/** An agent token as the console shows it: never the token, never its hash. */
export interface AgentTokenView {
  id: string;
  agentId: string;
  name: string;
  source: "console" | "env";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Passkey {
  credentialId: string;
  memberId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export type NewPasskey = Omit<Passkey, "memberId" | "createdAt" | "lastUsedAt">;

export interface Session {
  memberId: string;
  workspaceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export type AccessCodeKind = "claim" | "invite";

/** How long a session lasts at most, and unused. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session's last use is written at most this often, so reads do not become writes. */
const SESSION_TOUCH_MS = 5 * 60 * 1000;
/** A token's last use is written at most this often. */
const TOKEN_TOUCH_MS = 60 * 1000;

export const ENV_TOKEN_NAME = "Server env file (MCP_AUTH_TOKEN)";

export class AccountStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ---------------------------------------------------------------- workspaces and mandates

  workspace(id: string): Workspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  /** The workspace that holds the mandate following the server's contract: the one the migration made. */
  firstWorkspace(): Workspace {
    const row = this.db
      .prepare(
        "SELECT w.* FROM workspaces AS w JOIN mandates AS m ON m.workspace_id = w.id WHERE m.deployment = 'env'",
      )
      .get() as WorkspaceRow | undefined;
    if (!row) throw new Error("the store has no mandate for the server's contract");
    return workspaceFromRow(row);
  }

  /** The workspace's mandates, oldest first. */
  mandates(workspaceId: string): Mandate[] {
    const rows = this.db
      .prepare("SELECT * FROM mandates WHERE workspace_id = ? ORDER BY created_at, rowid")
      .all(workspaceId) as unknown as MandateRow[];
    return rows.map(mandateFromRow);
  }

  mandate(id: string): Mandate | null {
    const row = this.db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow | undefined;
    return row ? mandateFromRow(row) : null;
  }

  /** The mandate that follows the server's contract. */
  envMandate(): Mandate {
    const row = this.db.prepare("SELECT * FROM mandates WHERE deployment = 'env'").get() as
      MandateRow | undefined;
    if (!row) throw new Error("the store has no mandate for the server's contract");
    return mandateFromRow(row);
  }

  /** Every mandate with a contract of its own (`server` or `wallet`), oldest first, across workspaces. */
  contractMandates(): Mandate[] {
    const rows = this.db
      .prepare("SELECT * FROM mandates WHERE deployment IN ('server', 'wallet') ORDER BY created_at, rowid")
      .all() as unknown as MandateRow[];
    return rows.map(mandateFromRow);
  }

  /** The mandate whose own contract this is, or null. The `env` contract is not stored, so not found here. */
  mandateByContract(chainId: number, address: string): Mandate | null {
    const row = this.db
      .prepare("SELECT * FROM mandates WHERE chain_id = ? AND policy_address = ?")
      .get(chainId, address.toLowerCase()) as MandateRow | undefined;
    return row ? mandateFromRow(row) : null;
  }

  /**
   * Creates a mandate with no contract yet, and its agent with a new sealed key; with `ownerKey`, also the
   * owner key the console will deploy its contract from, sealed the same way. The workspace's count is
   * checked in the same transaction, so two requests at once cannot both pass the limit.
   */
  createMandate(input: {
    workspaceId: string;
    name: string;
    master: MasterKey;
    maxPerWorkspace: number;
    ownerKey: boolean;
  }): { ok: true; mandate: Mandate; agent: Agent } | { ok: false; count: number } {
    return transaction(this.db, () => {
      const { n } = this.db
        .prepare("SELECT COUNT(*) AS n FROM mandates WHERE workspace_id = ?")
        .get(input.workspaceId) as { n: number };
      if (n >= input.maxPerWorkspace) return { ok: false as const, count: n };
      const now = this.iso();
      const mandateId = newId("mnd");
      const agentId = newId("agt");
      const owner = input.ownerKey ? createSealedOwnerKey(input.master, mandateId) : null;
      this.db
        .prepare(
          `INSERT INTO mandates (id, workspace_id, name, owner_address, sealed_owner_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(mandateId, input.workspaceId, input.name, owner?.address ?? null, owner?.sealed ?? null, now);
      const key = createSealedAgentKey(input.master, agentId);
      this.db
        .prepare(
          `INSERT INTO agents (id, mandate_id, name, signer, address, sealed_key, created_at)
           VALUES (?, ?, ?, 'console', ?, ?, ?)`,
        )
        .run(agentId, mandateId, "Agent", key.address, key.sealed, now);
      const mandate = this.mandate(mandateId);
      const agent = this.agent(agentId);
      if (!mandate || !agent) throw new Error(`mandate ${mandateId} vanished after insert`);
      return { ok: true as const, mandate, agent };
    });
  }

  /**
   * Gives a mandate with no contract the one it was just deployed with. Null when it already has one, or
   * when another mandate has this contract (the unique index refuses it).
   */
  attachContract(
    mandateId: string,
    deployment: "server" | "wallet",
    contract: MandateContract,
  ): Mandate | null {
    try {
      const changed = this.db
        .prepare(
          `UPDATE mandates SET deployment = ?, chain_id = ?, policy_address = ?, deploy_block = ?,
             contract_kind = ?, executor_address = ?, owner_address = ?
           WHERE id = ? AND deployment IS NULL`,
        )
        .run(
          deployment,
          contract.chainId,
          contract.address.toLowerCase(),
          contract.deployBlock,
          contract.kind,
          contract.executor,
          contract.owner,
          mandateId,
        );
      if (Number(changed.changes) !== 1) return null;
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) return null;
      throw error;
    }
    return this.mandate(mandateId);
  }

  /**
   * A `server` contract found again on a chain that lost it: the console deployed it again from the same
   * owner key, at the same address, in a later block.
   */
  moveDeployBlock(mandateId: string, deployBlock: number): void {
    this.db
      .prepare("UPDATE mandates SET deploy_block = ? WHERE id = ? AND deployment = 'server'")
      .run(deployBlock, mandateId);
  }

  /** The owner key the console holds for a mandate, sealed; null when it holds none. */
  ownerKeyOf(mandateId: string): { address: Address; sealed: string } | null {
    const row = this.db
      .prepare("SELECT owner_address, sealed_owner_key FROM mandates WHERE id = ?")
      .get(mandateId) as { owner_address: string | null; sealed_owner_key: string | null } | undefined;
    if (!row?.owner_address || !row.sealed_owner_key) return null;
    return { address: getAddress(row.owner_address), sealed: row.sealed_owner_key };
  }

  // ---------------------------------------------------------------- owner actions

  /** Records an owner call the console signed, or tried to: who authorised it, with which passkey. */
  recordOwnerAction(input: {
    mandateId: string;
    memberId: string;
    credentialId: string | null;
    functionName: string;
    calldata: Hex;
    status: "sent" | "failed";
    txHash: Hex | null;
    detail: string | null;
  }): OwnerActionRecord {
    const id = newId("oac");
    this.db
      .prepare(
        `INSERT INTO owner_actions (id, mandate_id, member_id, credential_id, function_name, calldata, status,
           tx_hash, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.mandateId,
        input.memberId,
        input.credentialId,
        input.functionName,
        input.calldata,
        input.status,
        input.txHash,
        input.detail,
        this.iso(),
      );
    const record = this.ownerActions(input.mandateId, 1)[0];
    if (!record || record.id !== id) throw new Error(`owner action ${id} vanished after insert`);
    return record;
  }

  /** A mandate's owner calls the console signed, newest first. */
  ownerActions(mandateId: string, limit = 100): OwnerActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, m.name AS member_name FROM owner_actions AS a LEFT JOIN members AS m ON m.id = a.member_id
         WHERE a.mandate_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(mandateId, limit) as unknown as OwnerActionRow[];
    return rows.map((row) => ({
      id: row.id,
      mandateId: row.mandate_id,
      memberId: row.member_id,
      memberName: row.member_name,
      credentialId: row.credential_id,
      functionName: row.function_name,
      calldata: row.calldata as Hex,
      status: row.status,
      txHash: row.tx_hash as Hex | null,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }

  // ---------------------------------------------------------------- agents

  agent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? agentFromRow(row) : null;
  }

  /** The mandate's agent. Every mandate has exactly one. */
  agentOf(mandateId: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE mandate_id = ?").get(mandateId) as
      AgentRow | undefined;
    if (!row) throw new Error(`mandate ${mandateId} has no agent`);
    return agentFromRow(row);
  }

  /** The workspace's agents, with their mandates, in mandate order. */
  agentsOf(workspaceId: string): { mandate: Mandate; agent: Agent }[] {
    return this.mandates(workspaceId).map((mandate) => ({ mandate, agent: this.agentOf(mandate.id) }));
  }

  // ---------------------------------------------------------------- agent tokens

  /** Issues a token for an agent. The token is returned once and only its hash is stored. */
  createToken(agentId: string, name: string): { token: string; view: AgentTokenView } {
    const token = newAgentToken();
    const id = newId("tok");
    this.db
      .prepare(
        `INSERT INTO agent_tokens (id, agent_id, name, token_hash, source, created_at)
         VALUES (?, ?, ?, ?, 'console', ?)`,
      )
      .run(id, agentId, name, hashSecret(token), this.iso());
    const view = this.token(agentId, id);
    if (!view) throw new Error(`token ${id} vanished after insert`);
    return { token, view };
  }

  token(agentId: string, tokenId: string): AgentTokenView | null {
    const row = this.db
      .prepare("SELECT * FROM agent_tokens WHERE agent_id = ? AND id = ?")
      .get(agentId, tokenId) as TokenRow | undefined;
    return row ? tokenFromRow(row) : null;
  }

  /** An agent's tokens, active ones first, then newest first. */
  tokens(agentId: string): AgentTokenView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_tokens WHERE agent_id = ?
         ORDER BY revoked_at IS NOT NULL, created_at DESC, rowid DESC`,
      )
      .all(agentId) as unknown as TokenRow[];
    return rows.map(tokenFromRow);
  }

  /** Revokes one of the agent's tokens. Null when the agent has no such token; a revoked one stays revoked. */
  revokeToken(agentId: string, tokenId: string): AgentTokenView | null {
    this.db
      .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND id = ? AND revoked_at IS NULL")
      .run(this.iso(), agentId, tokenId);
    return this.token(agentId, tokenId);
  }

  /**
   * The live token with this hash, its agent and its mandate, or null for an unknown or revoked one.
   *
   * `legacy` marks the MCP server's own `MCP_AUTH_TOKEN`: the first time its hash is presented, and only if
   * the server's agent never had an env-file token before, it is registered for that agent. Once revoked it
   * is never registered again, so revoking it in the console is final.
   */
  resolveToken(
    tokenHash: string,
    legacy: boolean,
  ): { token: AgentTokenView; agent: Agent; mandate: Mandate } | null {
    return transaction(this.db, () => {
      let row = this.db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ?").get(tokenHash) as
        TokenRow | undefined;
      if (!row && legacy) {
        const registered = this.db
          .prepare("SELECT 1 FROM agent_tokens WHERE agent_id = ? AND source = 'env'")
          .get(ENV_AGENT_ID);
        if (!registered) {
          this.db
            .prepare(
              `INSERT INTO agent_tokens (id, agent_id, name, token_hash, source, created_at)
               VALUES (?, ?, ?, ?, 'env', ?)`,
            )
            .run(newId("tok"), ENV_AGENT_ID, ENV_TOKEN_NAME, tokenHash, this.iso());
          row = this.db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ?").get(tokenHash) as
            TokenRow | undefined;
        }
      }
      // The legacy flag never reaches a console-issued token, and a console token never acts as legacy.
      if (!row || row.revoked_at !== null || (row.source === "env") !== legacy) return null;
      const now = this.now().getTime();
      if (row.last_used_at === null || now - Date.parse(row.last_used_at) >= TOKEN_TOUCH_MS) {
        this.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(this.iso(), row.id);
        row = { ...row, last_used_at: this.iso() };
      }
      const agent = this.agent(row.agent_id);
      const mandate = agent ? this.mandate(agent.mandateId) : null;
      if (!agent || !mandate) return null;
      return { token: tokenFromRow(row), agent, mandate };
    });
  }

  // ---------------------------------------------------------------- access codes

  /** Stores a claim or invite code's hash. Claim codes name the workspace they claim. */
  createAccessCode(kind: AccessCodeKind, code: string, ttlMs: number, workspaceId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO access_codes (code_hash, kind, workspace_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashSecret(code), kind, workspaceId, this.iso(), this.iso(ttlMs));
  }

  /** The unused, unexpired code of this kind with this hash, or null. Claim codes of a claimed workspace are void. */
  accessCode(kind: AccessCodeKind, codeHash: string): { workspaceId: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT a.workspace_id FROM access_codes AS a LEFT JOIN workspaces AS w ON w.id = a.workspace_id
         WHERE a.code_hash = ? AND a.kind = ? AND a.used_at IS NULL AND a.expires_at > ?
           AND (a.kind = 'invite' OR w.claimed_at IS NULL)`,
      )
      .get(codeHash, kind, this.iso()) as { workspace_id: string | null } | undefined;
    return row ? { workspaceId: row.workspace_id } : null;
  }

  /** Marks a code used. False when it was used, expired or void meanwhile: the caller must then stop. */
  private useAccessCode(kind: AccessCodeKind, codeHash: string): { workspaceId: string | null } | null {
    const code = this.accessCode(kind, codeHash);
    if (!code) return null;
    this.db.prepare("UPDATE access_codes SET used_at = ? WHERE code_hash = ?").run(this.iso(), codeHash);
    return code;
  }

  /** How many unused codes of a kind are still valid (for the admin command; reveals nothing else). */
  openAccessCodes(kind: AccessCodeKind): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM access_codes WHERE kind = ? AND used_at IS NULL AND expires_at > ?")
      .get(kind, this.iso()) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------- members and passkeys

  member(id: string): Member | null {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined;
    return row ? memberFromRow(row) : null;
  }

  members(workspaceId: string): Member[] {
    const rows = this.db
      .prepare("SELECT * FROM members WHERE workspace_id = ? ORDER BY created_at, rowid")
      .all(workspaceId) as unknown as MemberRow[];
    return rows.map(memberFromRow);
  }

  /**
   * Creates a workspace with its first member and passkey, one mandate with no contract yet, and that
   * mandate's agent with a new sealed key. With an invite, the invite is used in the same transaction, so
   * one invite makes one workspace. Null when the invite is no longer valid.
   */
  signUp(input: {
    memberName: string;
    webauthnUserId: string;
    passkey: NewPasskey;
    inviteHash: string | null;
    master: MasterKey;
  }): { workspace: Workspace; member: Member } | null {
    return transaction(this.db, () => {
      if (input.inviteHash !== null && !this.useAccessCode("invite", input.inviteHash)) return null;
      const now = this.iso();
      const workspaceId = newId("wsp");
      const mandateId = newId("mnd");
      const agentId = newId("agt");
      this.db
        .prepare("INSERT INTO workspaces (id, name, created_at, claimed_at) VALUES (?, ?, ?, ?)")
        .run(workspaceId, `${input.memberName}'s workspace`, now, now);
      this.db
        .prepare("INSERT INTO mandates (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)")
        .run(mandateId, workspaceId, "Mandate", now);
      const key = createSealedAgentKey(input.master, agentId);
      this.db
        .prepare(
          `INSERT INTO agents (id, mandate_id, name, signer, address, sealed_key, created_at)
           VALUES (?, ?, ?, 'console', ?, ?, ?)`,
        )
        .run(agentId, mandateId, "Agent", key.address, key.sealed, now);
      const member = this.insertMember(workspaceId, input.memberName, input.webauthnUserId, input.passkey);
      const workspace = this.workspace(workspaceId);
      if (!workspace) throw new Error(`workspace ${workspaceId} vanished after insert`);
      return { workspace, member };
    });
  }

  /**
   * Makes the claimant the first member of the workspace the claim code names, and uses the code. Null when
   * the code is no longer valid or the workspace was claimed meanwhile.
   */
  claim(input: {
    claimHash: string;
    memberName: string;
    webauthnUserId: string;
    passkey: NewPasskey;
  }): { workspace: Workspace; member: Member } | null {
    return transaction(this.db, () => {
      const code = this.useAccessCode("claim", input.claimHash);
      if (!code?.workspaceId) return null;
      const claimed = this.db
        .prepare("UPDATE workspaces SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
        .run(this.iso(), code.workspaceId);
      if (Number(claimed.changes) !== 1) return null;
      const member = this.insertMember(
        code.workspaceId,
        input.memberName,
        input.webauthnUserId,
        input.passkey,
      );
      const workspace = this.workspace(code.workspaceId);
      if (!workspace) throw new Error(`workspace ${code.workspaceId} vanished`);
      return { workspace, member };
    });
  }

  private insertMember(
    workspaceId: string,
    name: string,
    webauthnUserId: string,
    passkey: NewPasskey,
  ): Member {
    const id = newId("mbr");
    this.db
      .prepare(
        "INSERT INTO members (id, workspace_id, name, webauthn_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, workspaceId, name, webauthnUserId, this.iso());
    this.addPasskey(id, passkey);
    const member = this.member(id);
    if (!member) throw new Error(`member ${id} vanished after insert`);
    return member;
  }

  addPasskey(memberId: string, passkey: NewPasskey): void {
    this.db
      .prepare(
        `INSERT INTO passkeys (credential_id, member_id, public_key, counter, transports, device_type, backed_up,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        passkey.credentialId,
        memberId,
        passkey.publicKey,
        passkey.counter,
        JSON.stringify(passkey.transports),
        passkey.deviceType,
        passkey.backedUp ? 1 : 0,
        this.iso(),
      );
  }

  passkey(credentialId: string): Passkey | null {
    const row = this.db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as
      PasskeyRow | undefined;
    return row ? passkeyFromRow(row) : null;
  }

  passkeysOf(memberId: string): Passkey[] {
    const rows = this.db
      .prepare("SELECT * FROM passkeys WHERE member_id = ? ORDER BY created_at, rowid")
      .all(memberId) as unknown as PasskeyRow[];
    return rows.map(passkeyFromRow);
  }

  /** Records a sign-in with a passkey: its new signature counter and the time. */
  usePasskey(credentialId: string, counter: number): void {
    this.db
      .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?")
      .run(counter, this.iso(), credentialId);
  }

  // ---------------------------------------------------------------- recovery codes

  /** Replaces the member's recovery code with this one's hash. */
  setRecoveryCode(memberId: string, code: string): void {
    this.db
      .prepare(
        `INSERT INTO recovery_codes (member_id, code_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT (member_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at`,
      )
      .run(memberId, hashSecret(code), this.iso());
  }

  /** The member a recovery code belongs to, without using it, or null. */
  recoveryCodeMember(codeHash: string): Member | null {
    const row = this.db.prepare("SELECT member_id FROM recovery_codes WHERE code_hash = ?").get(codeHash) as
      { member_id: string } | undefined;
    return row ? this.member(row.member_id) : null;
  }

  /** Uses a recovery code: the member it belonged to, whose code is now gone, or null. */
  useRecoveryCode(codeHash: string): Member | null {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT member_id FROM recovery_codes WHERE code_hash = ?")
        .get(codeHash) as { member_id: string } | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM recovery_codes WHERE member_id = ?").run(row.member_id);
      return this.member(row.member_id);
    });
  }

  // ---------------------------------------------------------------- sessions

  createSession(member: Member, idHash: string): Session {
    const now = this.iso();
    const session: Session = {
      memberId: member.id,
      workspaceId: member.workspaceId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: this.iso(SESSION_MAX_AGE_MS),
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, member_id, workspace_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(idHash, member.id, member.workspaceId, now, now, session.expiresAt);
    return session;
  }

  /** The live session with this id hash, its last use refreshed; null when unknown, expired or idle too long. */
  session(idHash: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as
      SessionRow | undefined;
    if (!row) return null;
    const now = this.now().getTime();
    if (Date.parse(row.expires_at) <= now || now - Date.parse(row.last_seen_at) > SESSION_IDLE_MS) {
      this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
      return null;
    }
    let lastSeen = row.last_seen_at;
    if (now - Date.parse(row.last_seen_at) >= SESSION_TOUCH_MS) {
      lastSeen = this.iso();
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(lastSeen, idHash);
    }
    return {
      memberId: row.member_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      lastSeenAt: lastSeen,
      expiresAt: row.expires_at,
    };
  }

  deleteSession(idHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  // ---------------------------------------------------------------- ceremonies

  /** Stores a WebAuthn ceremony's challenge and what it is for, until `ttlMs` from now. */
  putCeremony(idHash: string, kind: string, challenge: string, payload: unknown, ttlMs: number): void {
    this.db.prepare("DELETE FROM ceremonies WHERE expires_at <= ?").run(this.iso());
    this.db
      .prepare(
        "INSERT INTO ceremonies (id_hash, kind, challenge, payload, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(idHash, kind, challenge, JSON.stringify(payload), this.iso(ttlMs));
  }

  /** Removes and returns a ceremony, so its challenge is answered at most once. Null when unknown or expired. */
  takeCeremony(idHash: string, kind: string): { challenge: string; payload: unknown } | null {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM ceremonies WHERE id_hash = ?").get(idHash) as
        { kind: string; challenge: string; payload: string; expires_at: string } | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM ceremonies WHERE id_hash = ?").run(idHash);
      if (row.kind !== kind || Date.parse(row.expires_at) <= this.now().getTime()) return null;
      return { challenge: row.challenge, payload: JSON.parse(row.payload) as unknown };
    });
  }
}

// ------------------------------------------------------------------ rows

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
  claimed_at: string | null;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, createdAt: row.created_at, claimedAt: row.claimed_at };
}

interface MandateRow {
  id: string;
  workspace_id: string;
  name: string;
  deployment: MandateDeployment | null;
  chain_id: number | null;
  policy_address: string | null;
  deploy_block: number | null;
  contract_kind: "production" | "reference" | null;
  executor_address: string | null;
  owner_address: string | null;
  sealed_owner_key: string | null;
  created_at: string;
}

function mandateFromRow(row: MandateRow): Mandate {
  const own = row.deployment === "server" || row.deployment === "wallet";
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    deployment: row.deployment,
    contract:
      own &&
      row.chain_id !== null &&
      row.policy_address !== null &&
      row.deploy_block !== null &&
      row.contract_kind !== null &&
      row.executor_address !== null &&
      row.owner_address !== null
        ? {
            chainId: row.chain_id,
            address: getAddress(row.policy_address),
            deployBlock: row.deploy_block,
            kind: row.contract_kind,
            executor: getAddress(row.executor_address),
            owner: getAddress(row.owner_address),
          }
        : null,
    ownerKeyAddress: row.sealed_owner_key && row.owner_address ? getAddress(row.owner_address) : null,
    createdAt: row.created_at,
  };
}

interface OwnerActionRow {
  id: string;
  mandate_id: string;
  member_id: string;
  member_name: string | null;
  credential_id: string | null;
  function_name: string;
  calldata: string;
  status: "sent" | "failed";
  tx_hash: string | null;
  detail: string | null;
  created_at: string;
}

interface AgentRow {
  id: string;
  mandate_id: string;
  name: string;
  signer: "env" | "console";
  address: string | null;
  sealed_key: string | null;
  created_at: string;
}

function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id,
    mandateId: row.mandate_id,
    name: row.name,
    signer: row.signer,
    address: row.address ? getAddress(row.address) : null,
    sealedKey: row.sealed_key,
    createdAt: row.created_at,
  };
}

interface TokenRow {
  id: string;
  agent_id: string;
  name: string;
  token_hash: string;
  source: "console" | "env";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function tokenFromRow(row: TokenRow): AgentTokenView {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    source: row.source,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

interface MemberRow {
  id: string;
  workspace_id: string;
  name: string;
  role: "admin" | "viewer";
  webauthn_user_id: string;
  created_at: string;
}

function memberFromRow(row: MemberRow): Member {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    webauthnUserId: row.webauthn_user_id,
    createdAt: row.created_at,
  };
}

interface PasskeyRow {
  credential_id: string;
  member_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

function passkeyFromRow(row: PasskeyRow): Passkey {
  return {
    credentialId: row.credential_id,
    memberId: row.member_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports) as string[],
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

interface SessionRow {
  id_hash: string;
  member_id: string;
  workspace_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}
