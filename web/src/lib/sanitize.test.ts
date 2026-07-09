import { describe, expect, test } from "bun:test";
import { isFragmentHref, isInternalHref, isSafeHref } from "./sanitize";

// Same-page fragment links (`#section`) must survive the markdown link
// sanitizer so heading anchors / TOC targets work (#1912). They carry no
// scheme, so there's no javascript:/data: injection surface.
describe("isSafeHref", () => {
  test("allows http(s), mailto, and absolute internal paths", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:hi@example.com")).toBe(true);
    expect(isSafeHref("/docs/listing")).toBe(true);
  });

  test("allows same-page fragment links", () => {
    expect(isSafeHref("#pinning-your-listing")).toBe(true);
    expect(isSafeHref("  #with-leading-space")).toBe(true);
  });

  test("still rejects dangerous schemes and protocol-relative URLs", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("//evil.example.com")).toBe(false);
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});

describe("isFragmentHref", () => {
  test("true only for `#…` hrefs", () => {
    expect(isFragmentHref("#section")).toBe(true);
    expect(isFragmentHref("  #section")).toBe(true);
    expect(isFragmentHref("https://example.com#section")).toBe(false);
    expect(isFragmentHref("/docs/listing#section")).toBe(false);
    expect(isFragmentHref(undefined)).toBe(false);
    expect(isFragmentHref(null)).toBe(false);
  });
});

describe("isInternalHref", () => {
  test("true for same-origin absolute paths (including fragments)", () => {
    expect(isInternalHref("/submit")).toBe(true);
    expect(isInternalHref("/docs/listing")).toBe(true);
    expect(isInternalHref("/docs/listing#let-an-agent-write-it")).toBe(true);
    expect(isInternalHref("  /submit")).toBe(true);
  });

  test("false for external, protocol-relative, fragments, and empty", () => {
    expect(isInternalHref("https://releases.sh/submit")).toBe(false);
    expect(isInternalHref("//evil.example.com")).toBe(false);
    expect(isInternalHref("#section")).toBe(false);
    expect(isInternalHref(undefined)).toBe(false);
    expect(isInternalHref("")).toBe(false);
  });
});
