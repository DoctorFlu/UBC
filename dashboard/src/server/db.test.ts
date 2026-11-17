/**
 * Migrations apply by position (`PRAGMA user_version`), so a hosted console upgrades only if every
 * migration it already ran keeps its place and new ones come after. This builds databases exactly as
 * the consoles at main's versions 5 and 6 left them, with rows in them, and opens them with the current code.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MIGRATIONS, openDatabase } from "./db";

/**
 * SHA-256 of migrations 1 to 5 as shipped (main at 190fe37, the hosted console's schema), joined by NUL.
 * A change here means a shipped migration was edited or moved, which a deployed database never re-runs.
 */
const SHIPPED_V5_SHA256 = "0a0e02f733cd4c812b7facda9c22497f09de6f4d0b165f0048a6a9f381d68f51";

/** SHA-256 of migrations 1 to 6 as shipped (main at 2508c46, with the settlements of #92), joined by NUL. */
const SHIPPED_V6_SHA256 = "f595c104e5563ac1965cb0a8b2466a277699719b6762de0f1d971c845f1be328";

/** A database as the console at version `upTo` left it: write-ahead log mode, migrations 1 to `upTo`. */
function shippedDatabase(upTo: number): { dir: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), `mandate-console-v${String(upTo)}-`));
  const db = new DatabaseSync(join(dir, "console.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  for (const [index, migration] of MIGRATIONS.slice(0, upTo).entries()) {
    db.exec(migration);
    db.exec(`PRAGMA user_version = ${String(index + 1)}`);
  }
  return { dir, db };
}

function tables(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function version(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("console database migrations", () => {
  it("keeps the six shipped migrations as they are, in their places", () => {
    const hash = (count: number) =>
      createHash("sha256").update(MIGRATIONS.slice(0, count).join("\u0000")).digest("hex");
    expect(hash(5)).toBe(SHIPPED_V5_SHA256);
    expect(hash(6)).toBe(SHIPPED_V6_SHA256);
  });

  it("upgrades a version 5 database with data in it: the rows survive and settlements exist", () => {
    const { dir, db: old } = shippedDatabase(5);
    expect(version(old)).toBe(5);
    expect(tables(old)).toContain("wake_deliveries");
    expect(tables(old)).not.toContain("settlements");

    old
      .prepare(
        `INSERT INTO policy_events (deployment_id, tx_hash, log_index, block_number, block_timestamp, type,
           payload, source, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "5042002:0xabc",
        "0x01",
        0,
        7,
        1_763_000_000,
        "IntentProposed",
        "{}",
        "rpc",
        "2026-11-16T10:00:00Z",
      );
    old
      .prepare("INSERT INTO holdings (id, payload, updated_at) VALUES (1, ?, ?)")
      .run('[{"asset":"BTC","quantity":"0.5"}]', "2026-11-16T10:00:00Z");
    old
      .prepare(
        `INSERT INTO wake_deliveries (id, kind, status, detail, count, occurred_at, created_at, due_at,
           attempts, attempted_at, sent_at, result, counts_toward_cap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("wk_1", "owner_decision", "sent", "{}", 1, 1, 1, 1, 1, 1, 1, "HTTP 200", 1);
    old
      .prepare("INSERT INTO wake_sources (source_id, delivery_id, seen_at) VALUES (?, ?, ?)")
      .run("chain:5042002:0xabc:0x01:0", "wk_1", 1);
    old.close();

    const db = openDatabase(dir);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(7);
    expect(db.prepare("SELECT count(*) AS n FROM policy_events").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT payload FROM holdings WHERE id = 1").get()).toEqual({
      payload: '[{"asset":"BTC","quantity":"0.5"}]',
    });
    expect(db.prepare("SELECT status, result FROM wake_deliveries WHERE id = 'wk_1'").get()).toEqual({
      status: "sent",
      result: "HTTP 200",
    });
    expect(db.prepare("SELECT delivery_id FROM wake_sources").get()).toEqual({ delivery_id: "wk_1" });

    expect(tables(db)).toContain("settlements");
    db.prepare(
      `INSERT INTO settlements (deployment_id, intent_id, hash, document, signature, signer, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("5042002:0xabc", 0, "0xhash", "{}", "0xsig", "0xsigner", "2026-11-20T22:01:00Z");
    expect(db.prepare("SELECT count(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    db.close();

    // Opening again applies nothing twice.
    const again = openDatabase(dir);
    expect(version(again)).toBe(7);
    expect(again.prepare("SELECT count(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    again.close();
  });

  it("upgrades a version 6 database: its settlements survive and the venue order journal exists", () => {
    const { dir, db: old } = shippedDatabase(6);
    old
      .prepare(
        `INSERT INTO settlements (deployment_id, intent_id, hash, document, signature, signer, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("5042002:0xabc", 3, "0xhash", "{}", "0xsig", "0xsigner", "2026-11-20T22:01:00Z");
    expect(tables(old)).not.toContain("venue_orders");
    old.close();

    const db = openDatabase(dir);
    expect(version(db)).toBe(7);
    expect(db.prepare("SELECT intent_id FROM settlements").get()).toEqual({ intent_id: 3 });
    expect(tables(db)).toEqual(expect.arrayContaining(["venue_orders", "executor_venues"]));
    db.prepare(
      `INSERT INTO venue_orders (deployment_id, intent_id, revision, hash, document, signature, signer, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("5042002:0xabc", 3, 1, "0xhash", "{}", "0xsig", "0xsigner", "2026-11-20T22:01:00Z");
    db.close();
  });
});
