import { describe, it, expect } from "bun:test";
import {
  DEFAULT_PAGE_SIZE,
  computePagination,
  parseMetadataField,
  parseMetadataObject,
  formatTruncationWarning,
} from "@buildinternet/releases-core/cli-contracts";

describe("cli-contracts: computePagination", () => {
  it("populates totals when totalItems is provided", () => {
    const p = computePagination({ page: 2, pageSize: 50, returned: 50, totalItems: 233 });
    expect(p.page).toBe(2);
    expect(p.pageSize).toBe(50);
    expect(p.returned).toBe(50);
    expect(p.totalItems).toBe(233);
    expect(p.totalPages).toBe(5);
    expect(p.hasMore).toBe(true);
  });

  it("derives hasMore from returned === pageSize when totals unknown", () => {
    const p = computePagination({ page: 1, pageSize: 100, returned: 100 });
    expect(p.hasMore).toBe(true);
    expect(p.totalItems).toBeUndefined();
    expect(p.totalPages).toBeUndefined();
  });

  it("hasMore is false when returned < pageSize (unknown totals)", () => {
    const p = computePagination({ page: 1, pageSize: 100, returned: 17 });
    expect(p.hasMore).toBe(false);
  });

  it("hasMore is false on the exact last page when totals known", () => {
    const p = computePagination({ page: 5, pageSize: 50, returned: 33, totalItems: 233 });
    expect(p.hasMore).toBe(false);
    expect(p.totalPages).toBe(5);
  });

  it("empty result with known zero total has totalPages 1 (not 0)", () => {
    const p = computePagination({ page: 1, pageSize: 100, returned: 0, totalItems: 0 });
    expect(p.totalPages).toBe(1);
    expect(p.hasMore).toBe(false);
  });
});

describe("cli-contracts: parseMetadataField", () => {
  it("parses a JSON string into an object", () => {
    const result = parseMetadataField('{"fetchUrl":"https://example.com","feedEtag":"abc"}');
    expect(result).toEqual({ fetchUrl: "https://example.com", feedEtag: "abc" });
  });

  it("returns the original string if not valid JSON", () => {
    const result = parseMetadataField("not json");
    expect(result).toBe("not json");
  });

  it("passes through non-string values unchanged", () => {
    expect(parseMetadataField({ foo: "bar" })).toEqual({ foo: "bar" });
    expect(parseMetadataField(null)).toBeNull();
    expect(parseMetadataField(undefined)).toBeUndefined();
  });
});

describe("cli-contracts: parseMetadataObject", () => {
  it("returns the parsed object for a valid JSON string", () => {
    const result = parseMetadataObject('{"fetchUrl":"https://example.com"}');
    expect(result).toEqual({ fetchUrl: "https://example.com" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseMetadataObject("not json")).toBeNull();
  });

  it("returns null for a JSON string that parses to a non-object", () => {
    expect(parseMetadataObject('"a string"')).toBeNull();
    expect(parseMetadataObject("42")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseMetadataObject(null)).toBeNull();
    expect(parseMetadataObject(undefined)).toBeNull();
  });

  it("returns the same object for already-parsed input", () => {
    const obj = { fetchUrl: "x" };
    expect(parseMetadataObject(obj)).toBe(obj);
  });
});

describe("cli-contracts: formatTruncationWarning", () => {
  it("includes the returned count, page size, and example", () => {
    const msg = formatTruncationWarning({
      returned: 500,
      pageSize: 500,
      commandExample: "releases list --json --limit <n> --page <p>",
    });
    expect(msg).toContain("500 items returned");
    expect(msg).toContain("page size 500");
    expect(msg).toContain("releases list --json --limit <n> --page <p>");
  });
});

describe("cli-contracts: DEFAULT_PAGE_SIZE", () => {
  it("matches the API hard cap so a single default call maximizes the window", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(500);
  });
});
