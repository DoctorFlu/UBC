/**
 * Turns expected failures (a service not configured, the console or Gemini down, the chain RPC
 * unreachable, the key not being the contract's agent) into `unavailable` verdicts with a plain
 * hint. Grok Bot does not retry a failed call by itself, so a verdict that says what to do next is
 * worth more than an error. Anything not recognized is rethrown and becomes `INTERNAL`.
 */
import { BaseError, InsufficientFundsError } from "viem";
import { isGeminiError } from "@mandate/gemini";
import { PlannerInputError, UnresolvedPositionError } from "@mandate/planner";
import { PolicyClientError, PolicyRevertError, formatWait, rateLimitOf } from "@mandate/shared";
import { ConsoleClientError } from "../console/client";
import type { ToolContext } from "../context";
import { scrubText } from "../logger";
import { describeStop, NotEnoughTime, type CallDeadline } from "../mcp/deadline";
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

/** The reason code of a call stopped by its deadline (issue #105). */
export const TIMED_OUT = "TIMED_OUT";
/** The reason code of work not started because too little of the call's time was left. */
export const NOT_STARTED = "NOT_STARTED";

/**
 * The failure of a call its deadline stopped: what was slow, and to try again. Undefined while the
 * call runs.
 */
export function stoppedFailure(deadline: CallDeadline | undefined): Failure | undefined {
  const stop = deadline?.stop;
  if (deadline === undefined || stop === undefined) return undefined;
  return {
    reason: reason(TIMED_OUT, describeStop(stop, deadline.budgetMs)),
    nextAction: {
      actor: "agent",
      hint: "Try this call once more in a minute. If it times out again, tell the owner what was slow.",
    },
  };
}

/**
 * Maps an expected error to a failure, logging it scrubbed. Rethrows anything unexpected.
 *
 * Once the call's deadline has stopped it, an error is that stop (the upstream was cut off, it did
 * not fail), with one exception that always wins: a proposal that was sent and not confirmed stays
 * `TX_UNCONFIRMED`, because whoever reads it must never send that proposal again.
 */
export function describeFailure(
  error: unknown,
  ctx: Pick<ToolContext, "logger"> & { readonly deadline?: CallDeadline },
): Failure {
  const stopped = isUnconfirmed(error) ? undefined : stoppedFailure(ctx.deadline);
  if (stopped !== undefined) return stopped;
  if (error instanceof NotEnoughTime) {
    return {
      reason: reason(
        NOT_STARTED,
        "Too little of this call's time was left to start this safely, so nothing was sent.",
      ),
      nextAction: { actor: "agent", hint: "Call the tool again to continue." },
    };
  }
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
    // Said as it happened: an error on Gemini's side reads differently from a call that timed out.
    const what =
      error.code === "http" && error.status !== undefined && error.status >= 500
        ? `Gemini's market data is unavailable: Gemini answered with an error on its side (HTTP ${String(error.status)}).`
        : error.code === "rate_limited"
          ? "Gemini's market data is unavailable: Gemini is limiting how often this server may ask."
          : error.code === "invalid_response"
            ? "Gemini's market data is unavailable: Gemini answered with data this server could not read."
            : "Gemini's market data is unavailable: Gemini did not answer in time.";
    return {
      reason: reason("MARKET_DATA_UNAVAILABLE", `${what} Nothing was planned or proposed.`),
      nextAction: {
        actor: "agent",
        hint: "Tell the owner Gemini's market data is unavailable right now, and try this call again in a few minutes. Do not guess prices or strikes meanwhile.",
      },
    };
  }
  if (error instanceof UnresolvedPositionError) {
    return {
      reason: reason("POSITIONS_UNRESOLVED", error.message),
      nextAction: {
        actor: "agent",
        hint: "Do not buy on this ladder now: what is already held there cannot be counted. Tell the owner, and try again later.",
      },
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
  if (isUnconfirmed(error)) {
    return {
      reason: reason("TX_UNCONFIRMED", "The proposal was sent but not confirmed in time; it may still land."),
      nextAction: {
        actor: "agent",
        hint: "Call get_activity in a minute to see whether the intent was recorded. Do not propose it again before that.",
      },
    };
  }
  const limit = rateLimitOf(error);
  if (limit !== null) {
    const wait = limit.retryAfterMs === null ? "a minute" : formatWait(limit.retryAfterMs);
    return {
      reason: reason(
        "CHAIN_UNAVAILABLE",
        `The Arc RPC endpoint is rate-limiting this server; it asks us to wait ${wait}.`,
      ),
      nextAction: {
        actor: "agent",
        hint: "Try once more in a minute. If it is refused again, tell the owner the chain RPC is rate-limiting the server.",
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

/** A proposal that was sent, or may have been, and has no receipt yet. */
function isUnconfirmed(error: unknown): boolean {
  return error instanceof PolicyClientError && /no receipt/.test(error.message);
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
