import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import { escapeLikePattern } from "@buildinternet/releases-core/sql-like";

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
