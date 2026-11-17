"use client";

import { useCallback, useState } from "react";
import { BaseError, UserRejectedRequestError } from "viem";
import { useConfig } from "wagmi";
import { signMessage } from "wagmi/actions";

import { useLiveConsole } from "@/lib/live/LiveConsole";
import { useMandateScope, useMandateUrls } from "@/lib/mandate/MandateContext";
import { type OwnerAction, newNonce, ownerRequestMessage } from "@/lib/owner-request";

import { useOwnerAccess } from "./access";
import { PasskeyFailure, confirmWithPasskey } from "./passkey";

export type OwnerRequestResult<T> = { ok: true; data: T } | { ok: false; message: string; cancelled?: true };

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
  const mandateId = useMandateScope()?.mandate.id ?? null;
  const { api } = useMandateUrls();
  const { snapshot, refresh } = useLiveConsole();
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
        if (access.signer === "passkey") {
          // The console holds this mandate's owner key (#95): one passkey prompt confirms this very change.
          if (mandateId === null) return { ok: false, message: "This page shows no mandate." };
          const stepUp = await confirmWithPasskey({
            kind: "owner-request",
            mandateId,
            request: { action, payload },
          });
          const response = await fetch(api(path), {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload, stepUp }),
          });
          if (!response.ok) return { ok: false, message: await errorMessage(response) };
          const data = (await response.json()) as T;
          await refresh();
          return { ok: true, data };
        }
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
        const response = await fetch(api(path), {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload, auth: { issuedAt, nonce, signature } }),
        });
        if (!response.ok) return { ok: false, message: await errorMessage(response) };
        const data = (await response.json()) as T;
        await refresh();
        return { ok: true, data };
      } catch (error) {
        if (error instanceof PasskeyFailure) {
          return error.cancelled
            ? { ok: false, message: error.message, cancelled: true }
            : { ok: false, message: error.message };
        }
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
    [access, api, config, mandateId, refresh, snapshot.contract?.address, snapshot.network.chainId],
  );

  return { request, pending, access };
}
