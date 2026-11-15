import { z } from "zod";
import { addressSchema } from "./types";

/** Shape of `devchain/deployments/local.json`, written by `npm run dev:chain`. */
export const deploymentFileSchema = z.object({
  chainId: z.int().positive(),
  /** Which contract is deployed: the production `contracts/src/Policy.sol` or the devchain reference. */
  contract: z.enum(["production", "reference"]),
  rpcUrl: z.url(),
  address: addressSchema,
  /** Block the contract was deployed in: the first block worth scanning for events. */
  blockNumber: z.int().nonnegative(),
  user: addressSchema,
  agent: addressSchema,
  executor: addressSchema,
  deployedAt: z.iso.datetime({ offset: true }),
});
export type DeploymentFile = z.infer<typeof deploymentFileSchema>;
