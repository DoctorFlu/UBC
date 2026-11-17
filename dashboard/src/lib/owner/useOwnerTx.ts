"use client";

import {
  ARC_MIN_MAX_FEE_PER_GAS,
  type PolicyRules,
  applyFeeFloor,
  policyAbi,
  revertErrorName,
  rulesToChain,
} from "@mandate/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  BaseError,
  type Hex,
  UserRejectedRequestError,
  createPublicClient,
  encodeFunctionData,
  getContractError,
  http,
} from "viem";
import { useConfig } from "wagmi";
import { sendTransaction } from "wagmi/actions";

import { useLiveConsole } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { viemChain } from "@/lib/network";

import { useOwnerAccess } from "./access";

/** One owner write to the Policy contract. */
export type OwnerCall =
  | { functionName: "setPolicy"; rules: PolicyRules }
  | { functionName: "setPaused"; paused: boolean }
  | { functionName: "approveIntent"; intentId: number }
  | { functionName: "rejectIntent"; intentId: number };

/**
 * - `checking`: simulating the call, so a refusal shows before the wallet opens.
 * - `signing`: the wallet prompt is open.
 * - `pending`: sent, waiting to be mined.
 * - `syncing`: mined; waiting for the console to read its event, so every view agrees.
 */
export type OwnerTxState =
  | { phase: "idle" }
  | { phase: "checking" | "signing"; label: string }
  | { phase: "pending" | "syncing"; label: string; hash: Hex }
  | { phase: "done"; label: string; hash: Hex; synced: boolean }
  | { phase: "failed"; label: string; message: string; hash: Hex | null };

export type OwnerTxResult =
  { ok: false; message: string } | { ok: true; hash: Hex; snapshot: ConsoleSnapshot | null };

/** How long the console may take to show a mined transaction's event before the UI stops waiting. */
const SYNC_TIMEOUT_MS = 30_000;
const SYNC_POLL_MS = 2_000;

function callArgs(call: OwnerCall) {
  switch (call.functionName) {
    case "setPolicy":
      return [rulesToChain(call.rules)] as const;
    case "setPaused":
      return [call.paused] as const;
    case "approveIntent":
    case "rejectIntent":
      return [BigInt(call.intentId)] as const;
  }
}

function encode(call: OwnerCall): Hex {
  switch (call.functionName) {
    case "setPolicy":
      return encodeFunctionData({
        abi: policyAbi,
        functionName: "setPolicy",
        args: [rulesToChain(call.rules)],
      });
    case "setPaused":
      return encodeFunctionData({ abi: policyAbi, functionName: "setPaused", args: [call.paused] });
    case "approveIntent":
    case "rejectIntent":
      return encodeFunctionData({
        abi: policyAbi,
        functionName: call.functionName,
        args: [BigInt(call.intentId)],
      });
  }
}

const REVERT_MESSAGES: Record<string, string> = {
  NotUser: "Only the Policy contract's owner can do this, and this wallet is not the owner.",
  WrongStatus: "That intent was already decided, so there is nothing left to sign.",
};

function firstLine(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

function describeFailure(error: unknown): string {
  const declined =
    (error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError)) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === 4001);
  if (declined) {
    return "You declined the request in your wallet. Nothing was sent.";
  }
  const name = revertErrorName(error);
  if (name) return REVERT_MESSAGES[name] ?? `The contract refused the call (${name}).`;
  return firstLine(error);
}

/**
 * Sends owner transactions with the connected wallet: simulate (so a refusal never opens the wallet),
 * apply Arc's fee floor, sign, wait for the receipt, then wait until the console's own event feed shows
 * the transaction. Views update from that feed, never from this hook.
 */
export function useOwnerTx() {
  const config = useConfig();
  const access = useOwnerAccess();
  const { snapshot, waitFor, refresh } = useLiveConsole();
  const network = snapshot.network;
  const policy = snapshot.contract?.address ?? null;
  const [state, setState] = useState<OwnerTxState>({ phase: "idle" });
  const busy = useRef(false);

  const publicClient = useMemo(
    () => createPublicClient({ chain: viemChain(network), transport: http(network.rpcUrl) }),
    [network],
  );

  const send = useCallback(
    async (label: string, call: OwnerCall): Promise<OwnerTxResult> => {
      if (busy.current) return { ok: false, message: "Another owner transaction is still in progress." };
      if (access.kind !== "owner" || !policy) {
        const message = "reason" in access ? access.reason : "Connect the owner wallet first.";
        setState({ phase: "failed", label, message, hash: null });
        return { ok: false, message };
      }
      busy.current = true;
      let hash: Hex | null = null;
      try {
        setState({ phase: "checking", label });
        const data = encode(call);
        const estimate = await publicClient.estimateFeesPerGas({ type: "eip1559" });
        const fees = applyFeeFloor(estimate, network.kind === "arc-testnet" ? ARC_MIN_MAX_FEE_PER_GAS : 0n);
        try {
          await publicClient.call({ account: access.address, to: policy, data, ...fees });
        } catch (error) {
          if (!(error instanceof BaseError)) throw error;
          const refusal: BaseError = getContractError(error, {
            abi: policyAbi,
            address: policy,
            functionName: call.functionName,
            args: callArgs(call),
            sender: access.address,
          });
          throw refusal;
        }

        setState({ phase: "signing", label });
        const sent = await sendTransaction(config, {
          account: access.address,
          chainId: network.chainId,
          to: policy,
          data,
          ...fees,
        });
        hash = sent;
        setState({ phase: "pending", label, hash: sent });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: sent,
          pollingInterval: network.kind === "local" ? 100 : 500,
          timeout: 120_000,
        });
        if (receipt.status !== "success") {
          throw new Error("The transaction was mined but reverted. Nothing changed onchain.");
        }

        setState({ phase: "syncing", label, hash: sent });
        // The event stream normally brings the change; reading the snapshot too covers a stalled stream.
        const poll = setInterval(() => void refresh(), SYNC_POLL_MS);
        const seen = await waitFor(
          (next) => next.chain?.events.some((event) => event.transactionHash === sent) ?? false,
          SYNC_TIMEOUT_MS,
        ).finally(() => clearInterval(poll));
        setState({ phase: "done", label, hash: sent, synced: seen !== null });
        return { ok: true, hash: sent, snapshot: seen };
      } catch (error) {
        const message = describeFailure(error);
        setState({ phase: "failed", label, message, hash });
        return { ok: false, message };
      } finally {
        busy.current = false;
      }
    },
    [access, config, network, policy, publicClient, refresh, waitFor],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  const working =
    state.phase === "checking" ||
    state.phase === "signing" ||
    state.phase === "pending" ||
    state.phase === "syncing";
  return { state, send, reset, working, access };
}
