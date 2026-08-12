import { describe, expect, test } from "bun:test";
import { releaseLinkTarget } from "./release-link";

describe("releaseLinkTarget", () => {
  test("prefers the upstream URL when present", () => {
    expect(releaseLinkTarget({ id: "rel_1", url: "https://example.com/changelog#v2" })).toEqual({
      href: "https://example.com/changelog#v2",
      external: true,
    });
  });

  test("http URLs count as referenceable", () => {
    expect(releaseLinkTarget({ id: "rel_1", url: "http://example.com/notes" })).toEqual({
      href: "http://example.com/notes",
      external: true,
    });
  });

  test("falls back to the internal release page without a URL", () => {
    expect(releaseLinkTarget({ id: "rel_1", url: null })).toEqual({
      href: "/release/rel_1",
      external: false,
    });
    expect(releaseLinkTarget({ id: "rel_1", url: "   " })).toEqual({
      href: "/release/rel_1",
      external: false,
    });
  });

  test("non-http(s) URLs fall back to the internal page", () => {
    // javascript:/data:/ftp: etc. must never become the row's href.
    expect(releaseLinkTarget({ id: "rel_1", url: "javascript:alert(1)" })).toEqual({
      href: "/release/rel_1",
      external: false,
    });
  });

  test("returns null with neither URL nor id", () => {
    expect(releaseLinkTarget({ id: null, url: null })).toBeNull();
    expect(releaseLinkTarget({})).toBeNull();
  });
});
