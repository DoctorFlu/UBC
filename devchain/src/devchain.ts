import type { Capabilities, PolicyRules } from "@mandate/shared";
import { startAnvil, type AnvilInstance } from "./anvil";
import {
  DEMO_POLICY,
  deployPolicy,
  devPolicyClient,
  type Deployment,
  type PolicyContractKind,
} from "./deploy";

export interface Devchain {
  anvil: AnvilInstance;
  rpcUrl: string;
  deployment: Deployment;
  /** Which requested extensions the deployed contract has. */
  capabilities: Capabilities;
  stop: () => Promise<void>;
}

/**
 * Anvil with a freshly deployed Policy contract whose rules are already set by the devchain user
 * (the owner). Used by `npm run dev:chain` and by tests and smoke runs that need a whole chain in
 * one call, so they never have to act as the owner themselves.
 */
export async function startDevchain(
  options: { contract?: PolicyContractKind; port?: number; timestamp?: number; rules?: PolicyRules } = {},
): Promise<Devchain> {
  const anvil = await startAnvil({
    port: options.port ?? 8545,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  try {
    const deployment = await deployPolicy({
      rpcUrl: anvil.rpcUrl,
      contract: options.contract ?? "production",
    });
    const user = devPolicyClient(anvil.rpcUrl, deployment.address, "user");
    await user.setPolicy(options.rules ?? DEMO_POLICY);
    const capabilities = await user.getCapabilities();
    return { anvil, rpcUrl: anvil.rpcUrl, deployment, capabilities, stop: anvil.stop };
  } catch (error) {
    await anvil.stop();
    throw error;
  }
}
