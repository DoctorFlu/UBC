/**
 * An agent key held by the console (docs/accounts.md, "Agent keys and the signer interface"): the MCP
 * server never sees it. To propose, it sends the unsigned transaction to the console, which signs only a
 * `proposeTrade` to the agent's own mandate's Policy contract and refuses anything else.
 */
import {
  AGENT_ID_HEADER,
  CONSOLE_AGENT_ROUTES,
  consoleErrorSchema,
  signTransactionRequestSchema,
  signTransactionResponseSchema,
  toUnsignedTransaction,
  type AgentSigner,
} from "@mandate/shared";
import type { Address, Hex, TransactionSerializable } from "viem";
import { currentScopeSignal } from "../chain/rpc-scope";
import type { Secret } from "../secret";
import type { FetchLike } from "./resolver";

export const SIGN_TIMEOUT_MS = 8_000;

/**
 * Signing happens before the broadcast, inside the proposing call's scope (`withSignal`), so the call's
 * deadline stops it as it stops the call's RPC requests; after that only `SIGN_TIMEOUT_MS` bounds it.
 */
function signingSignal(): AbortSignal {
  const timeout = AbortSignal.timeout(SIGN_TIMEOUT_MS);
  const call = currentScopeSignal();
  return call === undefined ? timeout : AbortSignal.any([call, timeout]);
}

export class ConsoleSigner implements AgentSigner {
  readonly address: Address;
  readonly #agentId: string;
  readonly #baseUrl: string;
  readonly #serviceToken: Secret;
  readonly #fetch: FetchLike;

  constructor(options: {
    address: Address;
    agentId: string;
    baseUrl: string;
    serviceToken: Secret;
    fetch?: FetchLike;
  }) {
    this.address = options.address;
    this.#agentId = options.agentId;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#serviceToken = options.serviceToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
    const body = signTransactionRequestSchema.parse({ transaction: toUnsignedTransaction(transaction) });
    const signal = signingSignal();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${CONSOLE_AGENT_ROUTES.signTransaction}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.#serviceToken.reveal()}`,
          [AGENT_ID_HEADER]: this.#agentId,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      // Stopped by the call (its deadline, or the client going away): say so, as its other steps do.
      const call = currentScopeSignal();
      if (call?.aborted === true) throw call.reason as Error;
      throw new Error("The console did not answer the signing request");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const error = consoleErrorSchema.safeParse(payload);
      throw new Error(
        error.success
          ? `The console refused to sign: ${error.data.error.message}`
          : `The console answered HTTP ${String(response.status)} to the signing request`,
      );
    }
    const parsed = signTransactionResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error("The console's signature does not match the wire contract");
    return parsed.data.signed as Hex;
  }
}
