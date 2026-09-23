import { afterEach, describe, expect, it } from "bun:test";
import { GET } from "./route.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

describe("GET /api/og/org/[slug]", () => {
  it("renders the org card as image/png with the success cache header", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          name: "Anthropic",
          category: "ai",
          description: "AI safety and research company",
          domain: "anthropic.com",
          sourceCount: 4,
          releaseCount: 120,
          releasesLast30Days: 8,
          avatarUrl: "https://media.releases.sh/orgs/anthropic.png",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const res = await GET(
      new Request("https://releases.sh/api/og/org/anthropic"),
      params("anthropic"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
    );
  });

  it("falls back to the generic card with a no-store header on upstream failure", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    const res = await GET(new Request("https://releases.sh/api/og/org/missing"), params("missing"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
