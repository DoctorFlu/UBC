import { Category } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db";
import { ListingStore } from "./listings";

const BTC = "GEMI-BTC2611202200-HI65000";
const NFL = "GEMI-NFL-2611152125-SF-DAL-M-SF";

describe("ListingStore", () => {
  it("keeps the first verdict stored for a symbol", () => {
    const store = new ListingStore(openDatabase(":memory:"));
    const first = { listed: true as const, category: Category.Sports, checkedAt: "2026-11-15T12:00:00.000Z" };
    expect(store.save(NFL, first)).toEqual(first);
    expect(store.save(NFL, { listed: false, checkedAt: "2026-11-16T12:00:00.000Z" })).toEqual(first);
    expect(store.get([NFL, BTC])).toEqual(new Map([[NFL, first]]));
  });

  it("keeps verdicts across a restart of the console", () => {
    const db = openDatabase(":memory:");
    const verdict = { listed: false as const, checkedAt: "2026-11-15T12:00:00.000Z" };
    new ListingStore(db).save(BTC, verdict);
    expect(new ListingStore(db).get([BTC])).toEqual(new Map([[BTC, verdict]]));
  });
});
