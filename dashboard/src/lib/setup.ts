import type { ConsoleSnapshot } from "@/lib/live/types";
import type { OwnerMode } from "@/lib/owner/access";

export interface SetupStep {
  id: string;
  title: string;
  hint: string;
  done: boolean;
}

/**
 * Every step is read from somewhere real: the owner's access, the contract, or what the agent told the
 * console. `mode` says how the owner acts on this mandate, so no step asks a passkey owner for a wallet.
 */
export function setupSteps(snapshot: ConsoleSnapshot, ownerConnected: boolean, mode: OwnerMode): SetupStep[] {
  const pairing = snapshot.offchain.pairing;
  return [
    {
      id: "contract",
      title: "Point the console at the Policy contract",
      hint: "Locally, npm run dev:chain deploys one. On Arc testnet, set POLICY_ADDRESS.",
      done: snapshot.contract !== null,
    },
    mode === "passkey"
      ? {
          id: "owner-passkey",
          title: "Act as the owner with your passkey",
          hint: "The console holds this mandate's owner key; your passkey confirms each owner action, such as the rules and approvals.",
          done: ownerConnected,
        }
      : {
          id: "connect-wallet",
          title: "Connect your wallet",
          hint: "The wallet that holds the account the contract names as its owner: it signs the rules, approvals and pauses.",
          done: ownerConnected,
        },
    {
      id: "set-mandate",
      title: "Set the first rules",
      hint: "Budget, max trade size, markets, approval threshold and daily loss limit.",
      done: snapshot.chain?.rules != null,
    },
    {
      id: "add-mcp",
      title: "Add the MCP server to Grok Bot",
      hint: "Done when the agent's MCP server announces itself to this console.",
      done: pairing !== null,
    },
    {
      id: "confirm-agent",
      title: "Confirm the agent",
      hint:
        mode === "passkey"
          ? "Check the agent's name and address, then confirm it with your passkey."
          : "Check the agent's name and address, then sign to confirm it.",
      done: pairing?.status === "confirmed",
    },
    {
      id: "contract-agent",
      title: "The contract accepts the agent's key",
      hint: "The Policy contract only accepts proposals from the agent address it was set up with. The console reads it from the contract.",
      done: pairing?.isContractAgent === true,
    },
  ];
}
