import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import { escapeLikePattern } from "@buildinternet/releases-core/sql-like";
import { organizations } from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { getOrgsWithStats, countOrgsForList } from "../../workers/api/src/queries/orgs.js";
import type { D1Db } from "../../workers/api/src/db.js";

const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

describe("escapeLikePattern", () => {
  test("escapes backslash, percent, and underscore; leaves plain text alone", () => {
    expect(escapeLikePattern("foobar")).toBe("foobar");
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a\\%_b")).toBe("a\\\\\\%\\_b");
  });
});

describe("escapeLikePattern + SQLite LIKE ESCAPE roundtrip", () => {
  // bun:sqlite is the same engine D1 runs, so this proves the helper output
  // composes correctly with `LIKE ? ESCAPE '\'` against the real query planner.
  let db: Database;
  let stmt: Statement;
  beforeAll(() => {
    db = new Database(":memory:");
    stmt = db.prepare("SELECT 1 FROM (SELECT ? AS s) WHERE s LIKE ? ESCAPE '\\'");
  });
  afterAll(() => db.close());

  function matches(haystack: string, needle: string): boolean {
    return stmt.get(haystack, `%${escapeLikePattern(needle)}%`) !== null;
  }

  test("foo_bar matches literal but not fooXbar / foo1bar", () => {
    expect(matches("foo_bar", "foo_bar")).toBe(true);
    expect(matches("fooXbar", "foo_bar")).toBe(false);
    expect(matches("foo1bar", "foo_bar")).toBe(false);
  });

  test("100% matches literal but not 1000", () => {
    expect(matches("the 100% target", "100%")).toBe(true);
    expect(matches("1000 hits", "100%")).toBe(false);
  });

  test("plain substring matching still works", () => {
    expect(matches("Hello, world", "world")).toBe(true);
    expect(matches("Hello, world", "moon")).toBe(false);
  });
});

describe("getOrgsWithStats / countOrgsForList stay aligned on LIKE-special inputs", () => {
  // Regression for #734: a query like `foo_bar` used to match `fooXbar` too,
  // and the count helper inflated to match — pagination footer (page X of Y)
  // disagreed with the rendered slice. Both helpers go through the same
  // `orgListSearchWhere`, so this asserts they stay in lockstep.
  let tdb: TestDatabase;
  beforeAll(() => {
    tdb = createTestDb();
  });
  afterAll(() => tdb.cleanup());
  beforeEach(() => clearAllTables(tdb.db));

  async function seedOrgs(names: string[]) {
    await tdb.db.insert(organizations).values(
      names.map((name, i) => ({
        id: `org_${i}`,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
        discovery: "curated" as const,
      })),
    );
  }

  const cutoff = daysAgoIso(30);

  test("underscore is treated literally — `foo_bar` does not match `fooXbar`", async () => {
    await seedOrgs(["foo_bar", "fooXbar", "foo1bar", "unrelated"]);
    const rows = await getOrgsWithStats(asD1(tdb.db), cutoff, "foo_bar");
    const total = await countOrgsForList(asD1(tdb.db), "foo_bar");
    expect(rows.map((r) => r.name)).toEqual(["foo_bar"]);
    expect(total).toBe(1);
    expect(rows.length).toBe(total);
  });

  test("percent is treated literally — `100%` does not act as a wildcard", async () => {
    await seedOrgs(["100% pure", "1000 hits", "the 100%"]);
    const rows = await getOrgsWithStats(asD1(tdb.db), cutoff, "100%");
    const total = await countOrgsForList(asD1(tdb.db), "100%");
    expect(rows.map((r) => r.name).toSorted()).toEqual(["100% pure", "the 100%"]);
    expect(total).toBe(2);
    expect(rows.length).toBe(total);
  });
});
