import { describe, expect, it } from "bun:test";
import { routeMap } from "../../web/src/lib/route-map";

describe("routeMap", () => {
  const mappings: Array<[string, string]> = [
    ["/", "/api/format/home"],
    ["/docs", "/api/docs/index"],
    ["/docs/api/rest", "/api/docs/api/rest"],
    ["/docs/cli/admin", "/api/docs/cli/admin"],
    ["/privacy", "/api/format/page/privacy"],
    ["/terms", "/api/format/page/terms"],
    ["/security", "/api/format/page/security"],
    ["/search", "/api/format/page/search"],
    ["/status", "/api/format/page/status"],
    ["/source/foo", "/api/format/source/foo"],
    ["/release/rel_abc123", "/api/format/release/rel_abc123"],
    ["/vercel", "/api/format/vercel"],
    ["/vercel/nextjs", "/api/format/vercel/nextjs"],
    ["/vercel/product/nextjs", "/api/format/vercel/product/nextjs"],
  ];
  for (const [input, expected] of mappings) {
    it(`maps ${input} → ${expected}`, () => {
      expect(routeMap(input)).toBe(expected);
    });
  }

  const unsupported = [
    "/admin/status",
    "/admin/anything",
    "/api/anything",
    "/_next/static/x",
    "/.well-known/foo",
    "/favicon.ico",
    "/vercel/nextjs/extra/segment",
    "/sitemap.xml",
    "/llms.txt",
    "/llms-full.txt",
  ];
  for (const input of unsupported) {
    it(`returns null for ${input}`, () => {
      expect(routeMap(input)).toBeNull();
    });
  }

  it("prefers product match over two-segment fallback", () => {
    expect(routeMap("/vercel/product/nextjs")).toBe("/api/format/vercel/product/nextjs");
  });
});
