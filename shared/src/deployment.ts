import { z } from "zod";
import { addressSchema } from "./types";

/** Shape of `devchain/deployments/local.json`, written by `npm run dev:chain`. */
export const deploymentFileSchema = z.object({
  chainId: z.int().positive(),
  rpcUrl: z.url(),
  address: addressSchema,
  /** Block the contract was deployed in: the first block worth scanning for events. */
  blockNumber: z.int().nonnegative(),
  owner: addressSchema,
  agent: addressSchema,
  executor: addressSchema,
  deployedAt: z.iso.datetime({ offset: true }),
});
export type DeploymentFile = z.infer<typeof deploymentFileSchema>;
