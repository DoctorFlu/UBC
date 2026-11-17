import type { ConsoleSnapshot } from "@/lib/live/types";

export interface SetupStep {
  id: string;
  title: string;
  hint: string;
  done: boolean;
}

/** Every step is read from somewhere real: the wallet, the contract, or what the agent told the console. */
export function setupSteps(snapshot: ConsoleSnapshot, ownerConnected: boolean): SetupStep[] {
  const pairing = snapshot.offchain.pairing;
  return [
    {
      id: "contract",
      title: "Point the console at the Policy contract",
      hint: "Locally, npm run dev:chain deploys one. On Arc testnet, set POLICY_ADDRESS.",
      done: snapshot.contract !== null,
    },
    {
      id: "connect-wallet",
      title: "Connect the owner wallet",
      hint: "The contract's user(): the wallet that signs the mandate, approvals and the kill switch.",
      done: ownerConnected,
    },
    {
      id: "set-mandate",
      title: "Set the first mandate",
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
      hint: "Check the agent's name and address, then sign to confirm it.",
      done: pairing?.status === "confirmed",
    },
    {
      id: "contract-agent",
      title: "The agent's key is the contract's agent",
      hint: "The Policy contract only accepts proposals from agent(). The console reads it directly.",
      done: pairing?.isContractAgent === true,
    },
  ];
}
