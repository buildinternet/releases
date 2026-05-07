import { describe, test, expect } from "bun:test";
import { normalizeDomain } from "@buildinternet/releases-core/domain";

describe("normalizeDomain", () => {
  test("passes a bare apex domain through unchanged", () => {
    expect(normalizeDomain("vercel.com")).toBe("vercel.com");
  });

  test("lowercases", () => {
    expect(normalizeDomain("Vercel.COM")).toBe("vercel.com");
  });

  test("strips http and https schemes", () => {
    expect(normalizeDomain("https://vercel.com")).toBe("vercel.com");
    expect(normalizeDomain("http://vercel.com")).toBe("vercel.com");
  });

  test("rejects non-http schemes rather than guessing", () => {
    expect(normalizeDomain("mailto:user@vercel.com")).toBeNull();
    expect(normalizeDomain("ftp://vercel.com")).toBeNull();
  });

  test("strips path, query, and fragment", () => {
    expect(normalizeDomain("https://vercel.com/about")).toBe("vercel.com");
    expect(normalizeDomain("https://vercel.com/?ref=foo")).toBe("vercel.com");
    expect(normalizeDomain("https://vercel.com/path?x=1#frag")).toBe("vercel.com");
  });

  test("strips port", () => {
    expect(normalizeDomain("vercel.com:443")).toBe("vercel.com");
  });

  test("strips userinfo", () => {
    expect(normalizeDomain("https://user:pass@vercel.com")).toBe("vercel.com");
  });

  test("strips a leading www.", () => {
    expect(normalizeDomain("www.vercel.com")).toBe("vercel.com");
    expect(normalizeDomain("https://www.vercel.com")).toBe("vercel.com");
  });

  test("preserves non-www subdomains", () => {
    expect(normalizeDomain("docs.vercel.com")).toBe("docs.vercel.com");
    expect(normalizeDomain("https://blog.acme.co.uk")).toBe("blog.acme.co.uk");
  });

  test("strips trailing root-zone dot", () => {
    expect(normalizeDomain("vercel.com.")).toBe("vercel.com");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeDomain("  vercel.com  ")).toBe("vercel.com");
  });

  test("returns null on empty / whitespace only", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  test("returns null on inputs with internal whitespace", () => {
    expect(normalizeDomain("ver cel.com")).toBeNull();
  });

  test("returns null on bare TLD or single label", () => {
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("com")).toBeNull();
  });

  test("returns null on bare IPv4", () => {
    expect(normalizeDomain("1.2.3.4")).toBeNull();
  });

  test("returns null on illegal segment characters", () => {
    expect(normalizeDomain("ver_cel.com")).toBeNull();
    expect(normalizeDomain("vercel!.com")).toBeNull();
  });

  test("returns null on segments with leading or trailing hyphens", () => {
    expect(normalizeDomain("-vercel.com")).toBeNull();
    expect(normalizeDomain("vercel-.com")).toBeNull();
  });
});
