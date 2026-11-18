/**
 * Which chain, contract and key the executor runs with (#23), decided before it reads anything:
 *
 * - The local devchain (a deployment file, as `npm run dev:chain` and the hosted demo chain write): anvil's
 *   executor account, the contract's executor from the deploy script. `EXECUTOR_PRIVATE_KEY` is ignored.
 *   The file's RPC must be a devchain (loopback, or a compose service name such as `anvil`): a file that
 *   names any other host is refused, so anvil's key never signs on Arc through a hand-written file.
 * - A contract named by `POLICY_ADDRESS` (Arc testnet, or a chain of your own on a loopback RPC): the key
 *   in `EXECUTOR_PRIVATE_KEY`, which `npm run arc:keygen` makes. Off a loopback RPC it must not be one of
 *   anvil's published keys, and `POLICY_DEPLOY_BLOCK` must be set, so the executor never scans from block 0.
 *
 * The devchain uses Arc testnet's chain id, so where the executor signs, not the chain id, decides.
 * Never prints a key.
 */
import {
  PolicyClient,
  type ChainHead,
  type HeadCache,
  arcTestnet,
  devchain,
  politeHttp,
  rpcGate,
  sharedHead,
  type WriteLane,
} from "@mandate/shared";
import {
  type ResolvedDeployment,
  isDevchainRpc,
  isLoopbackUrl,
  wellKnownKeyRefusal,
} from "@mandate/shared/node";
import { type Address, type Chain, type Hex, createPublicClient, createWalletClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { devAccount } from "./accounts";

export interface ExecutorTarget {
  /** True on the local devchain or a loopback RPC: anvil's keys may sign there. */
  local: boolean;
  /** Where the executor signs, for its start-up line: never the RPC URL, which may carry a key. */
  network: string;
  chain: Chain;
  rpcUrl: string;
  policy: Address;
  deployBlock: bigint;
  account: PrivateKeyAccount;
}

/** A setting the executor cannot start with; the message names the variable, never a value. */
export class ExecutorConfigError extends Error {
  override readonly name = "ExecutorConfigError";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
}

export function executorTarget(
  env: Readonly<Record<string, string | undefined>>,
  deployment: Pick<ResolvedDeployment, "source" | "address" | "chain" | "rpcUrl" | "fromBlock">,
): ExecutorTarget {
  if (deployment.source === "devchain") {
    if (!isDevchainRpc(deployment.rpcUrl)) {
      throw new ExecutorConfigError(
        `The deployment file names an RPC at ${hostOf(deployment.rpcUrl)}, which is not a devchain (a ` +
          "loopback address or a compose service name), and the devchain's executor key is anvil's published " +
          "one. For Arc testnet set POLICY_ADDRESS and EXECUTOR_PRIVATE_KEY (npm run arc:keygen) instead.",
      );
    }
    return {
      local: true,
      network: "the local devchain",
      chain: deployment.chain,
      rpcUrl: deployment.rpcUrl,
      policy: deployment.address,
      deployBlock: deployment.fromBlock ?? 0n,
      account: devAccount("executor"),
    };
  }

  const local = isLoopbackUrl(deployment.rpcUrl);
  const network = local
    ? `a chain on ${hostOf(deployment.rpcUrl)}`
    : deployment.rpcUrl === arcTestnet.rpcUrls.default.http[0]
      ? "Arc testnet (public RPC)"
      : `Arc testnet (RPC at ${hostOf(deployment.rpcUrl)})`;
  const key = (env.EXECUTOR_PRIVATE_KEY ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  if (key === "") {
    throw new ExecutorConfigError(
      "EXECUTOR_PRIVATE_KEY is not set: the executor needs a key of its own for a contract named by " +
        "POLICY_ADDRESS. Run npm run arc:keygen.",
    );
  }
  let account: PrivateKeyAccount;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("not a key");
    account = privateKeyToAccount(key as Hex);
  } catch {
    throw new ExecutorConfigError(
      "EXECUTOR_PRIVATE_KEY is not a 32-byte hex private key (0x and 64 hex digits).",
    );
  }
  const refusal = wellKnownKeyRefusal("EXECUTOR_PRIVATE_KEY", key, {
    local,
    network: `${network}, which is not a loopback devchain`,
  });
  if (refusal !== null) throw new ExecutorConfigError(refusal);
  if (deployment.fromBlock === null && !local) {
    throw new ExecutorConfigError(
      "POLICY_DEPLOY_BLOCK is not set: set it to the contract's deploy block (contracts/README.md), so the " +
        "executor never scans the chain from block 0.",
    );
  }
  return {
    local,
    network,
    chain: local ? { ...devchain, rpcUrls: { default: { http: [deployment.rpcUrl] } } } : arcTestnet,
    rpcUrl: deployment.rpcUrl,
    policy: deployment.address,
    deployBlock: deployment.fromBlock ?? 0n,
    account,
  };
}

/** The executor's `PolicyClient` for the target's contract, signing with its key. */
export function executorPolicyClient(target: ExecutorTarget, lane?: WriteLane): PolicyClient {
  const chain = { ...target.chain, rpcUrls: { default: { http: [target.rpcUrl] } } };
  // Behind the process's rate-limit gate: after a refusal every request waits for it (up to a minute)
  // instead of asking again at once, and a refused transaction is sent again once it opens.
  const transport = politeHttp(target.rpcUrl, {
    ...(target.local ? {} : { timeout: 10_000 }),
    retryCount: target.local ? 3 : 2,
    maxWaitMs: RPC_GATE_WAIT_MS,
  });
  return new PolicyClient({
    address: target.policy,
    // Anvil mines at once; on Arc a block takes about half a second.
    publicClient: createPublicClient({ chain, transport, pollingInterval: target.local ? 100 : 1_000 }),
    walletClient: createWalletClient({ chain, transport, account: target.account }),
    ...(lane === undefined ? {} : { lane }),
  });
}

/** Most one chain request of the executor waits for the RPC's rate-limit gate to open. */
export const RPC_GATE_WAIT_MS = 60_000;

/**
 * The latest block, read once per polling interval for every contract the executor serves, and the
 * rate-limit gate of its endpoint: what each contract's watcher shares.
 */
export function executorHead(
  target: ExecutorTarget,
  client: PolicyClient,
): { head: (maxAgeMs: number) => Promise<bigint>; gate: ReturnType<typeof rpcGate> } {
  const cache: HeadCache = sharedHead(`${String(target.chain.id)}:${target.rpcUrl}`, async (): Promise<ChainHead> => {
    const block = await client.publicClient.getBlock({ blockTag: "latest" });
    return { number: block.number, timestamp: block.timestamp };
  });
  return {
    head: async (maxAgeMs) => (await cache.latest(maxAgeMs)).number,
    gate: rpcGate(target.rpcUrl),
  };
}

/** How often the executor reads `executor()` again while its key does not hold the role. */
export const ROLE_RECHECK_MS = 30_000;

/**
 * Resolves once the contract's `executor()` is this key. Until then it says, once per value read, which
 * address holds the role and the call that fixes it, and reads again every `recheckMs`: a container that
 * waits instead of exiting does not restart in a loop while the owner has not called the setter yet.
 * A read that fails is reported and tried again the same way.
 */
export async function waitForExecutorRole(options: {
  readExecutor: () => Promise<Address>;
  executor: Address;
  policy: Address;
  log: (line: string) => void;
  /** Applied to an error's text before it is logged: the RPC URL may carry a provider key. */
  redact?: (text: string) => string;
  recheckMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const recheckMs = options.recheckMs ?? ROLE_RECHECK_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: string | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    let state: string;
    try {
      const named = await options.readExecutor();
      if (named.toLowerCase() === options.executor.toLowerCase()) {
        if (last !== null)
          options.log(`[executor] ${options.executor} is now the executor of ${options.policy}.`);
        return;
      }
      state =
        `not the executor yet: ${options.policy} names ${named}, not this key's ${options.executor}. ` +
        `Ask the contract's owner to call setExecutor(${options.executor}); checking again every ` +
        `${String(Math.round(recheckMs / 1_000))} s.`;
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
      state =
        `could not read ${options.policy}'s executor (${(options.redact ?? ((text) => text))(reason)}); ` +
        `trying again every ${String(Math.round(recheckMs / 1_000))} s.`;
    }
    if (state !== last) options.log(`[executor] ${state}`);
    last = state;
    await sleep(recheckMs);
  }
}
