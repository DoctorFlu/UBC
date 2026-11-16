/**
 * `npm run redteam [-- options]`: attack the mandate and report what held.
 *
 *   (no options)                 Self-contained: for each Policy contract (production, then
 *                                reference), start a devchain and the MCP server on free ports, run
 *                                every attack, tear down.
 *   --contract <kind|both>       Self-contained run on one contract (default both).
 *   --target stack               Attack the running `npm run dev:stack` instead, so the attempts show
 *                                up in the console. Refuses anything that is not a loopback devchain.
 *   --json <file>                Write the full structured report.
 *   --markdown <file>            Write the Markdown report (from the first run).
 *
 * Exits 1 if any attack breaches, errors or behaves unexpectedly, and 2 if the target is refused.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildContracts, isPolicyContractKind, type PolicyContractKind } from "@mandate/devchain";
import {
  connectStack,
  endStateLines,
  line,
  markdown,
  passed,
  runRedTeam,
  startSelf,
  summaryLine,
  TargetRefused,
  type RunReport,
  type TargetHandle,
} from "./index";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "self" },
    contract: { type: "string", default: "both" },
    json: { type: "string" },
    markdown: { type: "string" },
  },
});

function fail(message: string, code = 2): never {
  process.stderr.write(`redteam: ${message}\n`);
  process.exit(code);
}

if (values.target !== "self" && values.target !== "stack") fail("--target must be self or stack");
const kinds: PolicyContractKind[] =
  values.contract === "both"
    ? ["production", "reference"]
    : isPolicyContractKind(values.contract)
      ? [values.contract]
      : [];
if (kinds.length === 0) fail("--contract must be production, reference or both");
if (values.target === "stack" && values.contract !== "both") {
  fail("--contract applies to the self-contained run; the stack has its own contract");
}

async function attack(connect: () => Promise<TargetHandle>, label: string): Promise<RunReport> {
  process.stdout.write(`\n=== ${label}\n`);
  const target = await connect();
  try {
    process.stdout.write(
      `  chain ${target.rpcUrl}, Policy ${target.policy} (${target.contract}); MCP ${target.mcpUrl}\n`,
    );
    process.stdout.write(
      `  markets: crypto ${target.markets.crypto}, disallowed ${target.markets.sports ?? "none found"}\n\n`,
    );
    const report = await runRedTeam(target, (record) => {
      process.stdout.write(`${line(record)}\n`);
    });
    process.stdout.write(`\n${summaryLine(report)}\n${endStateLines(report).join("\n")}\n`);
    return report;
  } finally {
    await target.stop();
  }
}

async function main(): Promise<void> {
  const reports: RunReport[] = [];
  if (values.target === "stack") {
    reports.push(await attack(connectStack, "live stack (npm run dev:stack)"));
  } else {
    process.stdout.write("Compiling the Policy contracts...\n");
    buildContracts();
    for (const contract of kinds) {
      reports.push(
        await attack(() => startSelf({ contract, build: false }), `self-contained, ${contract} contract`),
      );
    }
  }

  // Paths are relative to where the command was started (npm sets INIT_CWD).
  const base = process.env.INIT_CWD ?? process.cwd();
  if (values.json !== undefined) {
    writeFileSync(resolve(base, values.json), `${JSON.stringify(reports, null, 2)}\n`);
  }
  const first = reports[0];
  if (values.markdown !== undefined && first !== undefined) {
    writeFileSync(resolve(base, values.markdown), markdown(first));
  }
  const ok = reports.every(passed);
  const breaches = [
    ...new Set(reports.flatMap((r) => r.attacks.filter((a) => a.verdict === "BREACH").map((a) => a.id))),
  ];
  const surprises = [
    ...new Set(reports.flatMap((r) => r.attacks.filter((a) => !a.asExpected).map((a) => a.id))),
  ];
  process.stdout.write(
    ok
      ? "\nREDTEAM OK: no breach, every attack as expected\n"
      : `\nREDTEAM FAILED: breaches ${breaches.join(", ") || "none"}; unexpected ${surprises.join(", ") || "none"}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error: unknown) => {
  if (error instanceof TargetRefused) fail(`refusing to run: ${error.message}`);
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error), 1);
});
