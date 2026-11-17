/**
 * Accounts on the wire between the MCP server and the console (issue #94, docs/accounts.md).
 *
 * The console is the system of record for workspaces, mandates, agents and agent tokens. The MCP server
 * asks it which agent a bearer token belongs to, then names that agent in `AGENT_ID_HEADER` on every
 * agent API call, so every record it reads or writes belongs to that agent's mandate.
 *
 * Every agent key sits behind `AgentSigner`: an address and `signTransaction`, nothing else. The console's
 * key store, the MCP server's own key and any KMS, HSM or custody provider implement the same interface.
 */
import {
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerializable,
  decodeFunctionData,
  isAddressEqual,
  sha256,
  stringToBytes,
} from "viem";
import { toAccount } from "viem/accounts";
import { z } from "zod";
import { policyAbi } from "./abi";
import { addressSchema } from "./types";

/** The agent an agent API call acts for: an agent id from `resolveTokenResponseSchema`. */
export const AGENT_ID_HEADER = "x-mandate-agent";

/**
 * The agent whose key the MCP server holds itself (`AGENT_PRIVATE_KEY`, or the demo chain's agent): the
 * first mandate's agent. The MCP server names it with this id for work no token started, such as the
 * signal payment reports it sends from its outbox.
 */
export const ENV_AGENT_ID = "env";

/** Agent ids: `ENV_AGENT_ID` or `agt_` and 26 base32 characters. */
export const agentIdSchema = z.union([z.literal(ENV_AGENT_ID), z.string().regex(/^agt_[0-9a-z]{26}$/)]);
export type AgentId = z.infer<typeof agentIdSchema>;

/** Every token the console issues starts with this, so a leaked one is easy to recognise and scan for. */
export const AGENT_TOKEN_PREFIX = "mdt_";

/** A token as the console issues it: the prefix and 43 base64url characters (256 bits). */
export const agentTokenSchema = z.string().regex(/^mdt_[A-Za-z0-9_-]{43}$/);

/** The SHA-256 of a token, as 64 lowercase hex digits. The console stores and looks up only this. */
export function hashAgentToken(token: string): string {
  return sha256(stringToBytes(token)).slice(2);
}

export const tokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

// ------------------------------------------------------------------ token resolution

/**
 * POST `CONSOLE_AGENT_ROUTES.resolveToken`: which agent a bearer token belongs to.
 *
 * `legacy` is true only when the token is the MCP server's own `MCP_AUTH_TOKEN`. The console then registers
 * its hash for the first mandate's agent the first time it sees it, and from then on treats it like any
 * other token: revoked, it answers 401 like an unknown one.
 */
export const resolveTokenRequestSchema = z.strictObject({
  tokenHash: tokenHashSchema,
  legacy: z.boolean(),
});
export type ResolveTokenRequest = z.infer<typeof resolveTokenRequestSchema>;

export const SIGNER_KINDS = ["env", "console"] as const;
export type SignerKind = (typeof SIGNER_KINDS)[number];

export const resolveTokenResponseSchema = z.strictObject({
  workspaceId: z.string().min(1),
  mandateId: z.string().min(1),
  agentId: agentIdSchema,
  tokenId: z.string().min(1),
  agent: z.strictObject({
    /** The agent's address; null for the server's own key, whose address only the MCP server knows. */
    address: addressSchema.nullable(),
    /** `env`: the MCP server's own key signs. `console`: the console's key store signs. */
    signer: z.enum(SIGNER_KINDS),
  }),
  mandate: z.strictObject({
    /**
     * The Policy contract the mandate follows: `env` is the one the servers are configured with; null is
     * none yet. Phase 2 adds contracts recorded in the console.
     */
    deployment: z.literal("env").nullable(),
  }),
});
export type ResolveTokenResponse = z.infer<typeof resolveTokenResponseSchema>;

// ------------------------------------------------------------------ signing

const bigintString = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const hexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);

/** An EIP-1559 transaction to sign, with every number as a decimal string. */
export const unsignedTransactionSchema = z.strictObject({
  type: z.literal("eip1559"),
  chainId: z.number().int().positive(),
  nonce: z.number().int().nonnegative(),
  to: addressSchema,
  data: hexData,
  value: bigintString,
  gas: bigintString,
  maxFeePerGas: bigintString,
  maxPriorityFeePerGas: bigintString,
});
export type UnsignedTransaction = z.infer<typeof unsignedTransactionSchema>;

/** POST `CONSOLE_AGENT_ROUTES.signTransaction`: the console signs with the agent's key, or refuses. */
export const signTransactionRequestSchema = z.strictObject({ transaction: unsignedTransactionSchema });
export type SignTransactionRequest = z.infer<typeof signTransactionRequestSchema>;

export const signTransactionResponseSchema = z.strictObject({ signed: hexData });
export type SignTransactionResponse = z.infer<typeof signTransactionResponseSchema>;

export function toUnsignedTransaction(tx: TransactionSerializable): UnsignedTransaction {
  if (tx.chainId === undefined || tx.nonce === undefined || !tx.to || tx.gas === undefined) {
    throw new Error("a transaction to sign needs its chain id, nonce, recipient and gas");
  }
  if (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) {
    throw new Error("only EIP-1559 transactions are signed");
  }
  return {
    type: "eip1559",
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data ?? "0x",
    value: (tx.value ?? 0n).toString(),
    gas: tx.gas.toString(),
    maxFeePerGas: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
  };
}

export function fromUnsignedTransaction(tx: UnsignedTransaction): TransactionSerializable {
  return {
    type: "eip1559",
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data as Hex,
    value: BigInt(tx.value),
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  };
}

/**
 * Why an agent key may not sign `tx`, or null when it may: only `proposeTrade` (either overload) on the
 * mandate's own Policy contract and chain, with no value. An agent key has no other job, so nothing else
 * is ever signed, whoever asks.
 */
export function agentTransactionRefusal(
  tx: UnsignedTransaction,
  mandate: { policyAddress: Address; chainId: number },
): string | null {
  if (tx.chainId !== mandate.chainId) return "the transaction is for another chain than the mandate's";
  if (!isAddressEqual(tx.to, mandate.policyAddress)) {
    return "the transaction is not addressed to the mandate's Policy contract";
  }
  if (tx.value !== "0") return "an agent key never sends value";
  try {
    const { functionName } = decodeFunctionData({ abi: policyAbi, data: tx.data as Hex });
    if (functionName !== "proposeTrade") return `an agent key only proposes trades, not ${functionName}`;
  } catch {
    return "the transaction does not call the Policy contract";
  }
  return null;
}

// ------------------------------------------------------------------ the signer interface

/** One agent's key, wherever it lives. Callers see an address and a signature, never the key. */
export interface AgentSigner {
  readonly address: Address;
  /** The signed, serialized transaction, ready for `eth_sendRawTransaction`. */
  signTransaction(transaction: TransactionSerializable): Promise<Hex>;
}

/**
 * A viem account backed by `signer`, for wallet clients. It signs transactions only: an agent key has no
 * reason to sign a message or typed data, so those throw.
 */
export function signerAccount(signer: AgentSigner): LocalAccount {
  return toAccount({
    address: signer.address,
    signTransaction: (transaction) => signer.signTransaction(transaction as TransactionSerializable),
    signMessage: () => Promise.reject(new Error("an agent key signs transactions only")),
    signTypedData: () => Promise.reject(new Error("an agent key signs transactions only")),
  });
}
