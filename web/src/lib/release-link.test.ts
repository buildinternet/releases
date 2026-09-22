import { describe, expect, test } from "bun:test";
import { releaseLinkTarget, releaseLinkProps } from "./release-link";
import { EXTERNAL_UGC_REL } from "./sanitize";

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

  test("prefers a slugged internal path over the bare id fallback", () => {
    expect(
      releaseLinkTarget({ id: "rel_1", url: null, path: "/release/rel_1-voice-conversations" }),
    ).toEqual({ href: "/release/rel_1-voice-conversations", external: false });
  });

  test("ignores a path that isn't a /release/ path", () => {
    expect(releaseLinkTarget({ id: "rel_1", url: null, path: "/collections/x" })).toEqual({
      href: "/release/rel_1",
      external: false,
    });
  });

  test("an upstream URL still wins over a slugged path", () => {
    expect(
      releaseLinkTarget({
        id: "rel_1",
        url: "https://example.com/x",
        path: "/release/rel_1-slug",
      }),
    ).toEqual({ href: "https://example.com/x", external: true });
  });
});

describe("releaseLinkProps", () => {
  test("upstream link: new tab, UGC rel, data-release-id", () => {
    expect(releaseLinkProps({ id: "rel_a", url: "https://example.com/x" })).toEqual({
      href: "https://example.com/x",
      target: "_blank",
      rel: EXTERNAL_UGC_REL,
      "data-release-id": "rel_a",
    });
  });
  test("fallback link: internal path, still tagged", () => {
    expect(releaseLinkProps({ id: "rel_b", url: null })).toEqual({
      href: "/release/rel_b",
      "data-release-id": "rel_b",
    });
  });
  test("no id and no url → null", () => {
    expect(releaseLinkProps({ id: null, url: null })).toBeNull();
  });
  test("upstream link without an id omits the attribute", () => {
    expect(releaseLinkProps({ url: "https://example.com/y" })).toEqual({
      href: "https://example.com/y",
      target: "_blank",
      rel: EXTERNAL_UGC_REL,
    });
  });
});
