import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { tools } from "../src/tools";

/**
 * The tools Grok Bot calls are a public contract: their names and input schemas do not change.
 * `tool-inputs.frozen.json` is each tool's input JSON Schema as it was on main before workspaces (issue #94);
 * a change here needs a deliberate decision and a new snapshot, never a quiet edit.
 */
describe("the frozen tool surface", () => {
  const frozen = JSON.parse(
    readFileSync(new URL("./tool-inputs.frozen.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;

  it("has the same tool names", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(frozen).sort());
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))("keeps the input schema of %s", (name, tool) => {
    expect(z.toJSONSchema(tool.inputSchema, { io: "input" })).toEqual(frozen[name]);
  });
});
