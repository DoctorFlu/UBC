/**
 * Turns expected failures (a service not configured, the console or Gemini down, the chain RPC
 * unreachable, the key not being the contract's agent) into `unavailable` verdicts with a plain
 * hint. Grok Bot does not retry a failed call by itself, so a verdict that says what to do next is
 * worth more than an error. Anything not recognized is rethrown and becomes `INTERNAL`.
 */
import { BaseError, InsufficientFundsError } from "viem";
import { isGeminiError } from "@mandate/gemini";
import { PlannerInputError } from "@mandate/planner";
import { PolicyClientError, PolicyRevertError } from "@mandate/shared";
import { ConsoleClientError } from "../console/client";
import type { ToolContext } from "../context";
import { scrubText } from "../logger";
import { reason, unavailable, type NextAction, type Reason, type Verdict } from "../mcp/envelope";

export interface Failure {
  reason: Reason;
  nextAction: NextAction;
}

export const notConfigured = {
  policy: (): Failure => ({
    reason: reason("POLICY_NOT_CONFIGURED", "No Policy contract is configured on the server."),
    nextAction: {
      actor: "owner",
      hint: "Set POLICY_ADDRESS (and ARC_RPC_URL if not the public Arc testnet RPC) in the server's .env file, then restart the server.",
    },
  }),
  agentKey: (): Failure => ({
    reason: reason("AGENT_KEY_NOT_CONFIGURED", "The server has no agent key, so it cannot propose trades."),
    nextAction: {
      actor: "owner",
      hint: "Set AGENT_PRIVATE_KEY in the server's .env file on the machine that runs the server, then restart it. Never paste a key into chat.",
    },
  }),
  console: (): Failure => ({
    reason: reason("CONSOLE_NOT_CONFIGURED", "The server is not linked to the console."),
    nextAction: {
      actor: "owner",
      hint: "Set CONSOLE_SERVICE_TOKEN (and CONSOLE_URL if the console is not on localhost:3000) in the server's .env file, then restart the server.",
    },
  }),
  markets: (): Failure => ({
    reason: reason("MARKETS_NOT_CONFIGURED", "Market data is not available on this server."),
    nextAction: { actor: "owner", hint: "Restart the MCP server; market data needs no configuration." },
  }),
};

/** An `unavailable` verdict for a failure. */
export function unavailableFor(failure: Failure): Verdict {
  return unavailable([failure.reason], failure.nextAction);
}

/** Maps an expected error to a failure, logging it scrubbed. Rethrows anything unexpected. */
export function describeFailure(error: unknown, ctx: Pick<ToolContext, "logger">): Failure {
  const failure = classify(error);
  if (failure === null) throw error;
  ctx.logger.warn("tool.dependency_failed", {
    code: failure.reason.code,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? scrubText(error.message).slice(0, 300) : "",
  });
  return failure;
}

function classify(error: unknown): Failure | null {
  if (error instanceof ConsoleClientError) return consoleFailure(error);
  if (isGeminiError(error)) {
    if (error.code === "no_ladder") {
      return {
        reason: reason("NO_LADDER", error.message),
        nextAction: {
          actor: "agent",
          hint: "Pick one of the available ladders named above, or another horizon.",
        },
      };
    }
    if (error.code === "not_found" || error.code === "invalid_argument") {
      return {
        reason: reason("MARKET_NOT_FOUND", "Gemini has no market or event with that id."),
        nextAction: {
          actor: "agent",
          hint: "Call list_markets or get_ladder and use an id exactly as returned.",
        },
      };
    }
    return {
      reason: reason("MARKET_DATA_UNAVAILABLE", "Gemini's public market data did not answer in time."),
      nextAction: { actor: "agent", hint: "Try this call once more in a minute." },
    };
  }
  if (error instanceof PlannerInputError) {
    return {
      reason: reason("PLAN_INPUT_INVALID", error.message),
      nextAction: { actor: "agent", hint: "Fix the plan_hedge arguments and call it again." },
    };
  }
  if (error instanceof PolicyRevertError) {
    if (error.errorName === "NotAgent") {
      return {
        reason: reason("NOT_THE_AGENT", "The contract does not accept this server's key as its agent."),
        nextAction: {
          actor: "owner",
          hint: "In the console, set this agent's address (see whoami) as the mandate's agent with the owner's wallet.",
        },
      };
    }
    return {
      reason: reason(
        "CONTRACT_REFUSED",
        `The contract refused the call${error.errorName === null ? "" : ` (${error.errorName})`}.`,
      ),
      nextAction: {
        actor: "agent",
        hint: "Call get_policy and get_setup_state, then tell the owner what they show.",
      },
    };
  }
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError) !== null) {
    return {
      reason: reason("AGENT_NEEDS_GAS", "The agent's account cannot pay the network fee."),
      nextAction: {
        actor: "owner",
        hint: "Send Arc testnet USDC to the agent's address (see whoami), for example from faucet.circle.com.",
      },
    };
  }
  if (error instanceof PolicyClientError && /no receipt/.test(error.message)) {
    return {
      reason: reason("TX_UNCONFIRMED", "The proposal was sent but not confirmed in time; it may still land."),
      nextAction: {
        actor: "agent",
        hint: "Call get_activity in a minute to see whether the intent was recorded. Do not propose it again before that.",
      },
    };
  }
  if (error instanceof BaseError || error instanceof PolicyClientError) {
    return {
      reason: reason("CHAIN_UNAVAILABLE", "The Arc RPC endpoint did not answer."),
      nextAction: {
        actor: "agent",
        hint: "Try once more in a minute. If it fails again, tell the owner the chain RPC (ARC_RPC_URL) is unreachable.",
      },
    };
  }
  return null;
}

function consoleFailure(error: ConsoleClientError): Failure {
  switch (error.kind) {
    case "unreachable":
      return {
        reason: reason("CONSOLE_UNREACHABLE", "The console did not answer."),
        nextAction: {
          actor: "owner",
          hint: "Start the console, or check CONSOLE_URL in the server's .env file. The agent can retry once in a minute.",
        },
      };
    case "unauthorized":
      return {
        reason: reason("CONSOLE_UNAUTHORIZED", "The console refused the server's service token."),
        nextAction: {
          actor: "owner",
          hint: "Set the same CONSOLE_SERVICE_TOKEN for the console and the MCP server, then restart both.",
        },
      };
    case "rejected":
      return {
        reason: reason("CONSOLE_REJECTED", error.message),
        nextAction: { actor: "agent", hint: "Fix the arguments the console named and call the tool again." },
      };
    case "conflict":
      return {
        reason: reason("CONSOLE_CONFLICT", error.message),
        nextAction: {
          actor: "owner",
          hint: "The console already holds a different record for this; check it in the console.",
        },
      };
    case "bad_response":
      return {
        reason: reason(
          "CONSOLE_INCOMPATIBLE",
          "The console's answer does not match what this server expects.",
        ),
        nextAction: { actor: "owner", hint: "Update the console and the MCP server to matching versions." },
      };
  }
}
