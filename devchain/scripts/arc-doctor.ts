/**
 * `npm run arc:doctor [-- --owner 0x... --no-fork]`: read-only readiness check of the stack against the
 * Policy contract on Arc testnet (see `src/arc-doctor.ts`). Prints no key and no secret. Exit code 0 READY,
 * 1 NOT READY (with the next step), 2 Arc did not answer.
 */
import { parseArgs } from "node:util";
import { loadEnv } from "@mandate/shared";
import { arcDoctor } from "../src/arc-doctor";

const { values } = parseArgs({
  options: { owner: { type: "string" }, "no-fork": { type: "boolean", default: false } },
});

loadEnv();
process.stdout.write("Arc doctor: read-only. It sends no transaction to Arc and prints no key.\n\n");
const status = await arcDoctor({
  env: process.env,
  say: (line) => {
    process.stdout.write(`${line}\n`);
  },
  owner: values.owner,
  fork: !values["no-fork"],
});
process.exit(status);
