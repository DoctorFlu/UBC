import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AccountStore } from "./accounts/store";
import { migrate, openDatabase } from "./db";
import { OffchainStore } from "./store/offchain";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const T = "2026-11-15T10:00:00.000Z";

/** A version 4 database, the single-tenant schema the hosted console runs, with a row in every table. */
function singleTenantDatabase(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-migrate-"));
  const db = new DatabaseSync(join(dataDir, "console.sqlite"));
  migrate(db, 4);
  const run = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values);
  run(
    "INSERT INTO policy_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "31337:0xabc:1:0xdef",
    `0x${"11".repeat(32)}`,
    0,
    5,
    1_763_200_000,
    "IntentProposed",
    "{}",
    "rpc",
    T,
  );
  run("INSERT INTO ingest_cursors VALUES (?, ?, ?)", "31337:0xabc:1:0xdef", 6, T);
  run("INSERT INTO holdings VALUES (1, ?, ?)", JSON.stringify([{ asset: "BTC", quantity: "0.05" }]), T);
  for (const [index, hash] of [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`].entries()) {
    run("INSERT INTO decision_contexts VALUES (?, ?, ?)", hash, `{"n":${String(index)}}`, T);
  }
  for (const [planId, asset, storedAt] of [
    ["plan_1", "BTC", "2026-11-15T10:00:00.000Z"],
    ["plan_2", "BTC", "2026-11-15T11:00:00.000Z"],
    ["plan_3", "ETH", "2026-11-15T11:00:00.000Z"],
  ] as const) {
    run("INSERT INTO hedge_plans VALUES (?, ?, ?, ?, ?, ?)", planId, asset, "Protect it", T, "{}", storedAt);
  }
  run(
    "INSERT INTO policy_change_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "pcr_1",
    AGENT,
    JSON.stringify({ maxTradeCents: 3_000 }),
    "A bigger rung.",
    "pending",
    T,
    null,
    null,
  );
  run(
    "INSERT INTO pairings VALUES (?, ?, ?, ?, ?, ?, ?)",
    AGENT,
    "Grok Bot",
    "0.1.0",
    "confirmed",
    T,
    T,
    OWNER,
  );
  run(
    "INSERT INTO intent_context_links VALUES (?, ?, ?, ?, ?)",
    "31337:0xabc:1:0xdef",
    0,
    `0x${"aa".repeat(32)}`,
    `0x${"11".repeat(32)}`,
    T,
  );
  run("INSERT INTO signal_payments VALUES (?, ?, ?, ?)", `0x${"7c".repeat(32)}`, T, "{}", T);
  run("INSERT INTO signal_budget VALUES (1, ?, ?, ?)", T, "{}", T);
  run("INSERT INTO market_listings VALUES (?, ?, ?, ?)", "GEMI-BTC", 1, 1, T);
  db.close();
  return dataDir;
}

const OFFCHAIN_TABLES = [
  "holdings",
  "decision_contexts",
  "hedge_plans",
  "policy_change_requests",
  "pairings",
  "intent_context_links",
  "signal_payments",
  "signal_budget",
];

describe("migration to accounts (version 5)", () => {
  it("keeps every row, all in the first workspace's mandate, which nobody has claimed", () => {
    const dataDir = singleTenantDatabase();
    const before = new DatabaseSync(join(dataDir, "console.sqlite"));
    const counts = Object.fromEntries(
      [...OFFCHAIN_TABLES, "policy_events", "ingest_cursors", "market_listings"].map((table) => [
        table,
        (before.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    );
    before.close();

    const db = openDatabase(dataDir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    for (const [table, count] of Object.entries(counts)) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(count);
    }

    const accounts = new AccountStore(db);
    const workspace = accounts.firstWorkspace();
    expect(workspace.claimedAt).toBeNull();
    expect(accounts.members(workspace.id)).toEqual([]);
    const mandate = accounts.envMandate();
    expect(mandate.workspaceId).toBe(workspace.id);
    expect(accounts.agentOf(mandate.id)).toMatchObject({
      id: "env",
      signer: "env",
      address: null,
      sealedKey: null,
    });
    for (const table of OFFCHAIN_TABLES) {
      const owners = db.prepare(`SELECT DISTINCT mandate_id FROM ${table}`).all() as { mandate_id: string }[];
      expect(owners, table).toEqual([{ mandate_id: mandate.id }]);
    }

    const offchain = new OffchainStore(db);
    expect(offchain.holdings(mandate.id)).toEqual({
      holdings: [{ asset: "BTC", quantity: "0.05" }],
      updatedAt: T,
    });
    expect(offchain.latestPairing(mandate.id)).toMatchObject({
      agentAddress: AGENT,
      status: "confirmed",
      confirmedBy: OWNER,
    });
    expect(offchain.changeRequests(mandate.id).map((request) => request.id)).toEqual(["pcr_1"]);
    expect(offchain.latestPlans(mandate.id).map((plan) => plan.planId)).toEqual(["plan_3", "plan_2"]);
    expect(offchain.context(mandate.id, `0x${"bb".repeat(32)}`)?.document).toEqual({ n: 1 });
    expect(offchain.intentContextLink(mandate.id, "31337:0xabc:1:0xdef", 0)?.hash).toBe(
      `0x${"aa".repeat(32)}`,
    );
    // Another mandate sees none of it.
    expect(offchain.holdings("mnd_other").holdings).toEqual([]);
    expect(offchain.latestPlans("mnd_other")).toEqual([]);
  });

  it("runs once: opening the upgraded database again changes nothing", () => {
    const dataDir = singleTenantDatabase();
    const first = openDatabase(dataDir);
    const mandate = new AccountStore(first).envMandate();
    first.close();
    const again = openDatabase(dataDir);
    expect(new AccountStore(again).envMandate()).toEqual(mandate);
    expect((again.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n).toBe(1);
  });

  it("refuses an offchain row for a mandate that does not exist", () => {
    const db = openDatabase(":memory:");
    expect(() => new OffchainStore(db).saveHoldings("mnd_missing", [])).toThrow(/FOREIGN KEY/);
  });
});
