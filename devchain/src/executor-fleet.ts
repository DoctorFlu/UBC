/**
 * One executor key, every mandate's contract (#95). Each mandate has its own Policy contract, and each
 * names the same executor. The fleet asks the console which contracts name this key (a request signed
 * with it, `CONSOLE_EXECUTOR_ROUTES.contracts`), and runs one `startExecutor` per contract: its own
 * reads, venue, order journal and settlements, keyed by the contract. The contracts' clients share one
 * `WriteLane`, so the one key's transactions go one at a time and never race for a nonce.
 *
 * The console only lists; it cannot make the executor act. The executor reads each contract's
 * `executor()` itself before serving it, and acts only on intents the contract itself approved.
 */
import {
  CONSOLE_EXECUTOR_ROUTES,
  type ExecutorContract,
  executorContractsMessage,
  executorContractsResponseSchema,
} from "@mandate/shared";
import type { Hex } from "viem";
import type { Executor } from "./executor";

/** Signs a text message (EIP-191) with the executor key. */
export type MessageSigner = (message: string) => Promise<Hex>;

export interface DiscoveryOptions {
  consoleUrl: string;
  chainId: number;
  signMessage: MessageSigner;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
}

/** Lists the contracts on `chainId` whose executor is this key, as the console follows them. */
export function consoleContractDiscovery(options: DiscoveryOptions): () => Promise<ExecutorContract[]> {
  const base = options.consoleUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  return async () => {
    const issuedAt = new Date(now()).toISOString();
    const signature = await options.signMessage(
      executorContractsMessage({ chainId: options.chainId, issuedAt }),
    );
    const query = new URLSearchParams({ chainId: String(options.chainId), issuedAt, signature });
    const response = await send(`${base}${CONSOLE_EXECUTOR_ROUTES.contracts}?${query.toString()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok) throw new Error(`the console answered HTTP ${String(response.status)}`);
    return executorContractsResponseSchema
      .parse(await response.json())
      .contracts.filter((contract) => contract.chainId === options.chainId);
  };
}

export interface FleetOptions {
  /** Contracts served whatever `discover` answers: the server's own, which needs no console. */
  always?: readonly ExecutorContract[];
  /** The contracts to serve now. A failure keeps the ones already served and tries again later. */
  discover: () => Promise<ExecutorContract[]>;
  /**
   * Starts serving one contract, or answers why not (its `executor()` is another key, say). Called once
   * per contract while it is served; a refusal is asked again only after `retryRefusedMs`.
   */
  start: (contract: ExecutorContract) => Promise<Executor | { refused: string }>;
  /** How often to ask for contracts. Default 15 seconds. */
  intervalMs?: number;
  /** How long a refused contract waits before it is tried again. Default 5 minutes. */
  retryRefusedMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ExecutorFleet {
  /** Asks for contracts now and starts any new one; resolves when done. */
  refresh: () => Promise<void>;
  /** The contracts served, as `chainId:policy`. */
  serving: () => string[];
  stop: () => void;
}

function keyOf(contract: ExecutorContract): string {
  return `${String(contract.chainId)}:${contract.policy.toLowerCase()}`;
}

export function startExecutorFleet(options: FleetOptions): ExecutorFleet {
  const intervalMs = options.intervalMs ?? 15_000;
  const retryRefusedMs = options.retryRefusedMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const running = new Map<string, Executor>();
  const refused = new Map<string, number>();
  const starting = new Set<string>();
  let stopped = false;
  let lastProblem: string | null = null;

  async function serve(contract: ExecutorContract): Promise<void> {
    const key = keyOf(contract);
    if (running.has(key) || starting.has(key)) return;
    const refusedAt = refused.get(key);
    if (refusedAt !== undefined && now() - refusedAt < retryRefusedMs) return;
    starting.add(key);
    try {
      const started = await options.start(contract);
      if ("refused" in started) {
        if (refusedAt === undefined) log(`[executor] not serving ${contract.policy}: ${started.refused}`);
        refused.set(key, now());
        return;
      }
      if (stopped) {
        started.stop();
        return;
      }
      refused.delete(key);
      running.set(key, started);
      log(`[executor] serving ${contract.policy} from block ${String(contract.deployBlock)}`);
    } catch (error) {
      log(`[executor] could not start serving ${contract.policy} (${errorText(error)}); trying again later`);
    } finally {
      starting.delete(key);
    }
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    for (const contract of options.always ?? []) await serve(contract);
    let contracts: ExecutorContract[];
    try {
      contracts = await options.discover();
    } catch (error) {
      const problem = errorText(error);
      if (problem !== lastProblem) log(`[executor] could not list contracts yet (${problem}); trying again`);
      lastProblem = problem;
      return;
    }
    lastProblem = null;
    // One at a time: each start reads the chain, and the console never lists so many that it matters.
    for (const contract of contracts) await serve(contract);
  }

  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  return {
    refresh,
    serving: () => [...running.keys()].sort(),
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const executor of running.values()) executor.stop();
      running.clear();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
