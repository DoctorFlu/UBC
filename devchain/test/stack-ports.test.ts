/**
 * `npm run dev:stack` on a clean clone (issue #26): the signal API and the MCP server must listen on the
 * ports the stack waits on, with no `.env` setting them. Each service's own config reader decides here.
 */
import { describe, expect, it } from "vitest";
import { readSignalsConfig } from "../../signals/src/config";
import { STACK_DEFAULT_PORTS, stackPortEnv, stackPorts } from "../src/stack-ports";

/** The signal API refuses to start without a seller; any address will do for reading its port. */
const SELLER = { X402_SELLER_ADDRESS: "0x000000000000000000000000000000000000dEaD" };

describe("dev:stack ports", () => {
  it("starts the signal API on the port it waits on, on a clean clone that sets no port", () => {
    const ports = stackPorts({});
    expect(ports).toEqual(STACK_DEFAULT_PORTS);
    expect(readSignalsConfig({ ...SELLER }).port).not.toBe(ports.signals);
    expect(readSignalsConfig({ ...SELLER, ...stackPortEnv(ports).signals }).port).toBe(ports.signals);
  });

  it("follows SIGNALS_PORT and MCP_PORT from the environment, and treats a blank one as unset", () => {
    const ports = stackPorts({ SIGNALS_PORT: "9788", MCP_PORT: "9787" });
    expect(ports).toEqual({ signals: 9788, mcp: 9787 });
    expect(stackPortEnv(ports)).toEqual({ signals: { SIGNALS_PORT: "9788" }, mcp: { MCP_PORT: "9787" } });
    expect(stackPorts({ SIGNALS_PORT: " ", MCP_PORT: "" })).toEqual(STACK_DEFAULT_PORTS);
  });
});
