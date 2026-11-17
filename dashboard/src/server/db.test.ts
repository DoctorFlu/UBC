/**
 * Migrations apply by position (`PRAGMA user_version`), so a hosted console upgrades only if every
 * migration it already ran keeps its place and new ones come after. This builds a database exactly as
 * the console at main's version 5 left it, with rows in it, and opens it with the current code.
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
  it("keeps the five shipped migrations as they are, in their places", () => {
    const shipped = createHash("sha256").update(MIGRATIONS.slice(0, 5).join("\u0000")).digest("hex");
    expect(shipped).toBe(SHIPPED_V5_SHA256);
  });

  it("upgrades a version 5 database with data in it: the rows survive and settlements exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-console-v5-"));
    const old = new DatabaseSync(join(dir, "console.sqlite"));
    // As the hosted console keeps it: write-ahead log mode.
    old.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    for (const [index, migration] of MIGRATIONS.slice(0, 5).entries()) {
      old.exec(migration);
      old.exec(`PRAGMA user_version = ${String(index + 1)}`);
    }
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
    expect(MIGRATIONS.length).toBe(6);
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
    expect(version(again)).toBe(6);
    expect(again.prepare("SELECT count(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    again.close();
  });
});
