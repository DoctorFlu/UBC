/**
 * The operator's account commands, run on the server next to the console's database (docs/accounts.md):
 *
 *   claim-code   a one-time code that claims the first workspace (the server's own mandate), valid 24 h
 *   invite       a one-time code that lets one person create a new workspace, valid 7 days
 *   status       whether the first workspace is claimed, and how many codes are still open
 *
 * Each code is printed once, to stdout, and only its hash is stored. Locally: `npm run console:admin --
 * claim-code`. In the hosted console container: `node dashboard/admin.mjs claim-code`.
 */
import { resolve } from "node:path";

import { AccountError, issueClaimCode, issueInviteCode } from "../src/server/accounts/accounts";
import { AccountStore } from "../src/server/accounts/store";
import { DEFAULT_DATA_DIR } from "../src/server/config";
import { openDatabase } from "../src/server/db";

const USAGE = "Usage: admin <claim-code | invite | status>";

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (rest.length > 0 || command === undefined) {
    console.error(USAGE);
    return 2;
  }
  const dataDir = resolve(process.env.CONSOLE_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  const store = new AccountStore(openDatabase(dataDir));
  switch (command) {
    case "claim-code": {
      const { code } = issueClaimCode(store);
      console.error("Claim code for the first workspace. It works once, for 24 hours, and is not shown again:");
      console.log(code);
      console.error("Open the console's /claim page and enter it there.");
      return 0;
    }
    case "invite": {
      const code = issueInviteCode(store);
      console.error("Invite code for one new workspace. It works once, for 7 days, and is not shown again:");
      console.log(code);
      console.error("Send it to the person, who enters it on the console's /sign-up page.");
      return 0;
    }
    case "status": {
      const workspace = store.firstWorkspace();
      console.log(`first workspace: ${workspace.claimedAt ? `claimed ${workspace.claimedAt}` : "not claimed"}`);
      console.log(`open claim codes: ${String(store.openAccessCodes("claim"))}`);
      console.log(`open invite codes: ${String(store.openAccessCodes("invite"))}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof AccountError ? error.message : `admin failed: ${String(error)}`);
  process.exitCode = 1;
}
