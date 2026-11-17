import { spawn, type ChildProcess } from "node:child_process";
import { ARC_TESTNET_CHAIN_ID } from "@mandate/shared";
import { foundryBinary } from "./foundry";

export interface AnvilOptions {
  /** Port to listen on. 0 picks a free port. Defaults to 8545. */
  port?: number;
  host?: string;
  chainId?: number;
  /** Genesis block timestamp in unix seconds. */
  timestamp?: number;
  /** Forward anvil's output to this process's stdout. */
  verbose?: boolean;
  /** A chain to fork, read only through this RPC (`--fork-url`), at `forkBlock` when given. */
  fork?: { rpcUrl: string; block?: bigint };
  /** Lets any address send transactions unsigned (`--auto-impersonate`). */
  autoImpersonate?: boolean;
}

export interface AnvilInstance {
  rpcUrl: string;
  port: number;
  process: ChildProcess;
  stop: () => Promise<void>;
}

/** Starts anvil and resolves once it accepts connections. */
export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  const host = options.host ?? "127.0.0.1";
  const args = [
    "--host",
    host,
    "--port",
    String(options.port ?? 8545),
    "--chain-id",
    String(options.chainId ?? ARC_TESTNET_CHAIN_ID),
  ];
  if (options.timestamp !== undefined) args.push("--timestamp", String(options.timestamp));
  if (options.fork) {
    args.push("--fork-url", options.fork.rpcUrl);
    if (options.fork.block !== undefined) args.push("--fork-block-number", options.fork.block.toString());
  }
  if (options.autoImpersonate) args.push("--auto-impersonate");

  const child = spawn(foundryBinary("anvil"), args, { stdio: ["ignore", "pipe", "pipe"] });
  // Keep only a short tail of output: anvil logs every transaction, and the pipes must keep draining
  // for the life of the process or anvil blocks on a full pipe.
  let output = "";
  let ready = false;

  const port = await new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (options.verbose) process.stdout.write(text);
      if (ready) return;
      output = (output + text).slice(-4_000);
      const match = /Listening on [^\s:]+:(\d+)/.exec(output);
      if (match?.[1]) {
        ready = true;
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(
        new Error(`anvil exited with code ${String(code)} before it was ready:\n${output.slice(-2000)}`),
      );
    });
  });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => {
        resolve();
      });
      child.kill("SIGTERM");
    });

  return { rpcUrl: `http://${host}:${port}`, port, process: child, stop };
}
