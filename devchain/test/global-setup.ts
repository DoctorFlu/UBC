import { buildContracts } from "../src/foundry";

/** Compiles the reference contract once before any test file starts its own anvil. */
export default function setup(): void {
  buildContracts();
}
