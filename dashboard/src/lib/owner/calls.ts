/**
 * The owner's writes to a Policy contract, as data: what the owner's wallet sends, and what the console
 * signs for a mandate whose owner key it holds (#95), after a member's passkey authorises that exact call.
 */
import { policyAbi, policyRulesSchema, rulesToChain } from "@mandate/shared";
import { type Hex, encodeFunctionData } from "viem";
import { z } from "zod";

export const ownerCallSchema = z.discriminatedUnion("functionName", [
  z.strictObject({ functionName: z.literal("setPolicy"), rules: policyRulesSchema.strict() }),
  z.strictObject({ functionName: z.literal("setPaused"), paused: z.boolean() }),
  z.strictObject({ functionName: z.literal("approveIntent"), intentId: z.number().int().nonnegative() }),
  z.strictObject({ functionName: z.literal("rejectIntent"), intentId: z.number().int().nonnegative() }),
]);

/** One owner write to the Policy contract. */
export type OwnerCall = z.infer<typeof ownerCallSchema>;

/** The arguments `policyAbi` takes for the call. */
export function ownerCallArgs(call: OwnerCall) {
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

/** The call's calldata. */
export function encodeOwnerCall(call: OwnerCall): Hex {
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

/**
 * Whether a session alone may have the console sign this call: only pausing, the kill switch, which must
 * be fast and only ever stops trading. Every other call (approve, reject, rules, unpause) needs a passkey.
 */
export function needsPasskey(call: OwnerCall): boolean {
  return !(call.functionName === "setPaused" && call.paused);
}
