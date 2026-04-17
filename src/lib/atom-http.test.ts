import { describe, it, expect } from "bun:test";
import { atomEtag, formatLastModified, shouldReturn304 } from "./atom-http.js";

describe("atomEtag", () => {
  it("returns a weak ETag in the canonical form", () => {
    const tag = atomEtag("hello");
    expect(tag).toMatch(/^W\/"[0-9a-f]+"$/);
  });

  it("is stable across calls", () => {
    expect(atomEtag("same body")).toBe(atomEtag("same body"));
  });

  it("changes when the body changes", () => {
    expect(atomEtag("a")).not.toBe(atomEtag("b"));
  });
});

describe("formatLastModified", () => {
  it("produces RFC 7231 UTC strings", () => {
    expect(formatLastModified("2026-04-10T12:34:56Z")).toBe("Fri, 10 Apr 2026 12:34:56 GMT");
  });

  it("returns null for missing / invalid inputs", () => {
    expect(formatLastModified(null)).toBeNull();
    expect(formatLastModified(undefined)).toBeNull();
    expect(formatLastModified("not a date")).toBeNull();
  });
});

describe("shouldReturn304", () => {
  const etag = 'W/"abc123"';
  const lastMod = "Fri, 10 Apr 2026 12:34:56 GMT";

  it("matches on exact weak ETag", () => {
    expect(shouldReturn304(etag, lastMod, etag, null)).toBe(true);
  });

  it("matches on the strong form of the same ETag", () => {
    expect(shouldReturn304(etag, lastMod, '"abc123"', null)).toBe(true);
  });

  it("matches on wildcard If-None-Match", () => {
    expect(shouldReturn304(etag, lastMod, "*", null)).toBe(true);
  });

  it("matches when any tag in a comma list equals the ETag", () => {
    expect(shouldReturn304(etag, lastMod, 'W/"old", W/"abc123", W/"new"', null)).toBe(true);
  });

  it("does not match when ETags differ", () => {
    expect(shouldReturn304(etag, lastMod, 'W/"different"', null)).toBe(false);
  });

  it("matches on If-Modified-Since when the feed has not changed", () => {
    expect(shouldReturn304(etag, lastMod, null, "Fri, 10 Apr 2026 13:00:00 GMT")).toBe(true);
  });

  it("does not match If-Modified-Since when the feed is newer", () => {
    expect(shouldReturn304(etag, lastMod, null, "Fri, 10 Apr 2026 12:00:00 GMT")).toBe(false);
  });

  it("ignores If-Modified-Since when no Last-Modified was set", () => {
    expect(shouldReturn304(etag, null, null, "Fri, 10 Apr 2026 13:00:00 GMT")).toBe(false);
  });

  it("returns false when no validators are present", () => {
    expect(shouldReturn304(etag, lastMod, null, null)).toBe(false);
  });

  it("prefers ETag match over a stale If-Modified-Since", () => {
    // Caller sends both; ETag matches so we should 304 even if the timestamp
    // comparison would have said the client is out of date.
    expect(
      shouldReturn304(etag, lastMod, etag, "Fri, 10 Apr 2026 00:00:00 GMT"),
    ).toBe(true);
  });
});
