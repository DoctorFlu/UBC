/**
 * The ports `npm run dev:stack` runs the MCP server and the signal API on, and the environment that tells
 * each one its port.
 *
 * The stack waits for each service on the port it chose, so it must pass that port on: the signal API's
 * own default (4021) is not the stack's, and a clean clone has no `.env` that sets it. Without this the
 * stack waited 240 s for a signal API listening elsewhere, then stopped (issue #26).
 */
export interface StackPorts {
  mcp: number;
  signals: number;
}

export const STACK_DEFAULT_PORTS: StackPorts = { mcp: 8787, signals: 8788 };

/** The ports from `MCP_PORT` and `SIGNALS_PORT` when set, the stack's defaults otherwise. */
export function stackPorts(env: NodeJS.ProcessEnv): StackPorts {
  return {
    mcp: Number(env.MCP_PORT?.trim() || STACK_DEFAULT_PORTS.mcp),
    signals: Number(env.SIGNALS_PORT?.trim() || STACK_DEFAULT_PORTS.signals),
  };
}

/** What each service is started with, so it listens where the stack waits for it. */
export function stackPortEnv(ports: StackPorts): {
  mcp: { MCP_PORT: string };
  signals: { SIGNALS_PORT: string };
} {
  return {
    mcp: { MCP_PORT: String(ports.mcp) },
    signals: { SIGNALS_PORT: String(ports.signals) },
  };
}
