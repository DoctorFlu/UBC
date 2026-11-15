import type { Tool } from "../mcp/tool";
import { getSetupState } from "./get-setup-state";
import { ping } from "./ping";
import { whoami } from "./whoami";

/**
 * Every tool the server exposes.
 *
 * To add a tool, create `src/tools/<name>.ts` with `defineTool`, then add its import above and one
 * entry below. Keep both lists alphabetical so tools added in parallel rarely touch the same lines.
 */
// prettier-ignore
export const tools: readonly Tool[] = [
  getSetupState,
  ping,
  whoami,
];
