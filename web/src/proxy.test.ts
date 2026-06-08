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
