import * as z from "zod";

/** The public address an MCP server reports it was reached at: an https URL, or null. */
export const publicMcpUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(300)
  .nullable();

/** GET /api/console/mcp-server: what Setup shows as the address to give Grok Bot. */
export type McpServerStatus =
  /** `MCP_PUBLIC_URL` is set: the address, as configured. */
  | { kind: "configured"; url: string }
  /** No public address configured, and no MCP server address on this machine to ask. */
  | { kind: "unknown" }
  /**
   * The MCP server on this machine: its local address, whether it answered just now, and the public
   * address a tunnel last reached it at (null until one did).
   */
  | { kind: "local"; localUrl: string; running: boolean; publicUrl: string | null };

export const MCP_SERVER_PATH = "/api/console/mcp-server";
