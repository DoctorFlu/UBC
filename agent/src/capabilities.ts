import { isConfigured, type Config } from "./config";

/** Which groups of features the current configuration can support. */
export interface Capabilities {
  /** Read the Policy contract: needs the RPC URL and the policy address. */
  readonly readPolicy: boolean;
  /** Submit trade intents: needs policy reads plus the agent key. */
  readonly proposeTrades: boolean;
  /** Read holdings and send change requests to the console: needs its URL and service token. */
  readonly console: boolean;
  /** Buy signals: needs the signal API URL and the agent key that pays. */
  readonly buySignals: boolean;
}

export function capabilitiesOf(config: Config): Capabilities {
  const readPolicy = isConfigured(config, "ARC_RPC_URL") && isConfigured(config, "POLICY_ADDRESS");
  const hasKey = isConfigured(config, "AGENT_PRIVATE_KEY");
  return {
    readPolicy,
    proposeTrades: readPolicy && hasKey,
    console: isConfigured(config, "CONSOLE_URL") && isConfigured(config, "CONSOLE_SERVICE_TOKEN"),
    buySignals: isConfigured(config, "SIGNALS_URL") && hasKey,
  };
}
