import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";

describe("toFtsMatchQuery", () => {
  test("wraps a single token in a phrase quote", () => {
    expect(toFtsMatchQuery("react")).toBe('"react"');
  });

  test("treats whitespace as a token separator and AND-joins", () => {
    expect(toFtsMatchQuery("dark mode")).toBe('"dark" "mode"');
  });

  test("preserves slashes inside a phrase (FTS5 will tokenize internally)", () => {
    expect(toFtsMatchQuery("Shopify/toxiproxy")).toBe('"Shopify/toxiproxy"');
  });

  test("preserves colons, parens, and other FTS5 syntax characters", () => {
    expect(toFtsMatchQuery("@scope/pkg")).toBe('"@scope/pkg"');
    expect(toFtsMatchQuery("foo:bar (baz)")).toBe('"foo:bar" "(baz)"');
  });

  test("strips embedded quotes so the wrapping pair is well-formed", () => {
    expect(toFtsMatchQuery('he said "hi"')).toBe('"he" "said" "hi"');
  });

  test("collapses empty / whitespace-only input to an empty phrase", () => {
    expect(toFtsMatchQuery("")).toBe('""');
    expect(toFtsMatchQuery("   ")).toBe('""');
  });
});

describe("toFtsMatchQuery — exercised against a real FTS5 table", () => {
  // Behavioral guarantee: every output passes the FTS5 parser. Pre-fix,
  // raw `Shopify/toxiproxy` raised `fts5: syntax error near "/"`.
  test.each([
    ["Shopify/toxiproxy"],
    ["@scope/pkg"],
    ["foo:bar"],
    ["1 + 2"],
    ['"quoted"'],
    [""],
    ["a/b/c d:e"],
  ])("does not throw on %p", (input) => {
    const sqlite = new Database(":memory:");
    sqlite.run(`CREATE VIRTUAL TABLE t USING fts5(body)`);
    sqlite.run(`INSERT INTO t(body) VALUES ('shopify toxiproxy is a tool')`);
    const ftsQuery = toFtsMatchQuery(input);
    expect(() => sqlite.query(`SELECT rowid FROM t WHERE t MATCH ?`).all(ftsQuery)).not.toThrow();
    sqlite.close();
  });
});
