import { describe, it, expect, spyOn, afterEach, mock } from "bun:test";
import { NextRequest } from "next/server";
import { api } from "@/lib/api";
import { GET } from "./route";

const RELEASE = {
  id: "rel_abc123",
  title: "v1.2.0",
  version: "1.2.0",
  url: "https://example.com/changelog#v1.2.0",
  content: "Fixed a bug.",
  publishedAt: "2026-10-01T00:00:00Z",
  source: { slug: "acme-cli", name: "Acme CLI", org: { slug: "acme", name: "Acme" } },
} as unknown as Awaited<ReturnType<typeof api.release>>;

function call(format: string) {
  const req = new NextRequest(`https://releases.sh/api/format/release/rel_abc123?format=${format}`);
  return GET(req, { params: Promise.resolve({ id: "rel_abc123" }) });
}

describe("release format route", () => {
  afterEach(() => {
    mock.restore();
  });

  it("serves JSON for .json, marked noindex", async () => {
    spyOn(api, "release").mockResolvedValue(RELEASE);
    const res = await call("json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await res.json()).toMatchObject({ id: "rel_abc123", version: "1.2.0" });
  });

  it("serves markdown for .md, marked noindex", async () => {
    spyOn(api, "release").mockResolvedValue(RELEASE);
    const res = await call("md");
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("404s for .atom without fetching the release", async () => {
    const spy = spyOn(api, "release").mockResolvedValue(RELEASE);
    const res = await call("atom");
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});
