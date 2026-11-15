"use client";

import { useCallback, useState } from "react";
import { BaseError, UserRejectedRequestError } from "viem";
import { useConfig } from "wagmi";
import { signMessage } from "wagmi/actions";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { type OwnerAction, newNonce, ownerRequestMessage } from "@/lib/owner-request";

import { useOwnerAccess } from "./access";

export type OwnerRequestResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Not JSON: fall through.
  }
  return `The console answered ${response.status.toString()}.`;
}

/**
 * Offchain owner changes (holdings, pairing, change requests): the owner's wallet signs a readable
 * message naming the action, a digest of the payload, this contract and chain, a time and a nonce, and
 * the console checks the signer is the Policy contract's `user()` (see lib/owner-request.ts).
 */
export function useOwnerRequest() {
  const config = useConfig();
  const access = useOwnerAccess();
  const snapshot = useSnapshot();
  const [pending, setPending] = useState(false);

  const request = useCallback(
    async <T>(
      path: string,
      method: "POST" | "PUT",
      action: OwnerAction,
      payload: unknown,
    ): Promise<OwnerRequestResult<T>> => {
      if (access.kind !== "owner") {
        return { ok: false, message: "reason" in access ? access.reason : "Connect the owner wallet first." };
      }
      const policyAddress = snapshot.contract?.address;
      if (!policyAddress) return { ok: false, message: "No Policy contract is configured yet." };
      setPending(true);
      try {
        const issuedAt = new Date().toISOString();
        const nonce = newNonce();
        const message = ownerRequestMessage({
          action,
          payload,
          policyAddress,
          chainId: snapshot.network.chainId,
          issuedAt,
          nonce,
        });
        const signature = await signMessage(config, { account: access.address, message });
        const response = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload, auth: { issuedAt, nonce, signature } }),
        });
        if (!response.ok) return { ok: false, message: await errorMessage(response) };
        return { ok: true, data: (await response.json()) as T };
      } catch (error) {
        if (error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError)) {
          return { ok: false, message: "You declined the signature in your wallet. Nothing changed." };
        }
        return {
          ok: false,
          message: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
        };
      } finally {
        setPending(false);
      }
    },
    [access, config, snapshot.contract?.address, snapshot.network.chainId],
  );

  return { request, pending, access };
}
