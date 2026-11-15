import { isConfigured, type Config } from "./config";

/** Which groups of features the current configuration can support. */
export interface Capabilities {
  /** Read the Policy contract: needs the policy address (the RPC URL has a default). */
  readonly readPolicy: boolean;
  /** Submit trade intents: needs policy reads plus the agent key. */
  readonly proposeTrades: boolean;
  /** Read holdings and send change requests to the console: needs the console service token. */
  readonly console: boolean;
}

export function capabilitiesOf(config: Config): Capabilities {
  const readPolicy = isConfigured(config, "POLICY_ADDRESS");
  return {
    readPolicy,
    proposeTrades: readPolicy && isConfigured(config, "AGENT_PRIVATE_KEY"),
    console: isConfigured(config, "CONSOLE_SERVICE_TOKEN"),
  };
}
