import { describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function run(path: string) {
  return proxy(new NextRequest(new URL(`https://releases.sh${path}`)));
}

describe("proxy /auth.md guard", () => {
  it("passes /auth.md through to the static file without a markdown rewrite", () => {
    const res = run("/auth.md");
    // NextResponse.next() carries no rewrite header; the static public/auth.md serves.
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("still rewrites other .md suffix paths to the markdown format route", () => {
    const res = run("/vercel.md");
    expect(res.headers.get("x-middleware-rewrite")).toContain("/api/format/vercel");
  });
});

describe("proxy /schemas guard", () => {
  it("passes /schemas/*.json through to the static file without a format rewrite", () => {
    const res = run("/schemas/releases.json");
    // Without the guard, the .json suffix matcher rewrites to
    // /api/format/schemas/releases and 404s. NextResponse.next() lets the
    // static public/schemas/releases.json serve.
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("still rewrites other .json suffix paths to the format route", () => {
    const res = run("/vercel.json");
    expect(res.headers.get("x-middleware-rewrite")).toContain("/api/format/vercel");
  });
});

describe("proxy legacy ?tab= redirects", () => {
  function locationOf(path: string) {
    const res = run(path);
    return { status: res.status, location: res.headers.get("location") };
  }

  it("308s an org-level legacy tab to its path-based route, dropping the query", () => {
    expect(locationOf("/vercel?tab=sources")).toEqual({
      status: 308,
      location: "https://releases.sh/vercel/sources",
    });
    expect(locationOf("/vercel?tab=fetch-log")).toEqual({
      status: 308,
      location: "https://releases.sh/vercel/fetch-log",
    });
    expect(locationOf("/vercel?tab=admin")).toEqual({
      status: 308,
      location: "https://releases.sh/vercel/admin",
    });
  });

  it("308s a source-level legacy tab on the org-scoped path", () => {
    expect(locationOf("/vercel/next?tab=changelog")).toEqual({
      status: 308,
      location: "https://releases.sh/vercel/next/changelog",
    });
  });

  it("308s a source-level legacy tab on the /sources/:id path", () => {
    expect(locationOf("/sources/src_abc?tab=highlights")).toEqual({
      status: 308,
      location: "https://releases.sh/sources/src_abc/highlights",
    });
  });

  it("does NOT redirect reserved top-level routes that happen to carry a tab query", () => {
    // The org-slug redirect must never hijack a real top-level route.
    expect(run("/login?tab=releases").headers.get("location")).toBeNull();
    expect(run("/docs?tab=releases").headers.get("location")).toBeNull();
    expect(run("/search?tab=sources").headers.get("location")).toBeNull();
  });

  it("ignores unknown tab values and the wrong tab set for a depth", () => {
    // Non-legacy value on an org path → render the org page (no redirect).
    expect(run("/vercel?tab=whatever").headers.get("location")).toBeNull();
    // Org-only tab on a 2-segment path is not a source tab → no redirect.
    expect(run("/vercel/next?tab=sources").headers.get("location")).toBeNull();
    // Source-only tab on a 1-segment org path → no redirect.
    expect(run("/vercel?tab=highlights").headers.get("location")).toBeNull();
  });

  it("passes through org paths with no tab query", () => {
    expect(run("/vercel").headers.get("location")).toBeNull();
  });
});
