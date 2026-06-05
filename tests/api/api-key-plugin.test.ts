import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apikey } from "../../workers/api/src/db/schema-auth.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("apikey table", () => {
  it("is created by the migration and is queryable", () => {
    h = createTestDb();
    // No rows yet, but the table must exist (migration applied by the harness).
    const rows = h.db.select().from(apikey).all();
    expect(rows).toEqual([]);
  });
});
