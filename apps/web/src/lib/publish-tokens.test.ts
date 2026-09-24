import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const {
  listPublishTokens,
  createPublishToken,
  revokePublishToken,
  listPublishableSources,
  publishWorkflowSnippet,
} = await import("./publish-tokens.js");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
/** Route by URL suffix; unmatched URLs 500. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const hit = Object.entries(routes).find(([suffix]) => String(url).endsWith(suffix));
    const status = hit ? (hit[1].status ?? 200) : 500;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (hit ? hit[1].body : {}),
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

const claim = (slug: string, status: string) => ({
  id: `claim_${slug}_${status}`,
  org: { slug, name: slug.toUpperCase(), webUrl: `https://releases.sh/${slug}` },
  status,
  createdAt: "2026-09-01T00:00:00Z",
  expiresAt: "2026-10-01T00:00:00Z",
});

describe("publish-tokens client", () => {
  it("lists with credentials", async () => {
    mockFetch({ "/v1/me/publish-tokens": { body: { publishTokens: [{ id: "tok_1" }] } } });
    expect(await listPublishTokens()).toEqual([{ id: "tok_1" }] as never);
    expect(calls[0]!.url).toBe("https://api.test/v1/me/publish-tokens");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("returns null when the lane is off (404)", async () => {
    mockFetch({ "/v1/me/publish-tokens": { status: 404, body: {} } });
    expect(await listPublishTokens()).toBeNull();
  });

  it("creates via a credentialed POST and surfaces the envelope message on failure", async () => {
    mockFetch({ "/v1/me/publish-tokens": { status: 201, body: { token: "relk_x" } } });
    await createPublishToken({ sourceId: "src_1", name: "ci" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ sourceId: "src_1", name: "ci" });

    mockFetch({
      "/v1/me/publish-tokens": { status: 403, body: { error: { message: "claim required" } } },
    });
    await expect(createPublishToken({ sourceId: "src_1", name: "ci" })).rejects.toThrow(
      "claim required",
    );
  });

  it("revokes via a credentialed DELETE with an encoded id", async () => {
    mockFetch({ "/v1/me/publish-tokens/a%2Fb": { body: {} } });
    await revokePublishToken("a/b");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("collects sources from verified claims only, deduped per org", async () => {
    mockFetch({
      "/v1/listing/claims": {
        body: {
          claims: [claim("acme", "verified"), claim("acme", "verified"), claim("beta", "pending")],
        },
      },
      "/v1/orgs/acme": {
        body: {
          sources: [
            { id: "src_a", slug: "cl", name: "Changelog" },
            { slug: "noid", name: "x" },
          ],
        },
      },
    });
    const out = await listPublishableSources();
    expect(out).toEqual({
      verifiedOrgCount: 1,
      sources: [{ id: "src_a", name: "Changelog", slug: "cl", orgSlug: "acme", orgName: "ACME" }],
    });
    expect(calls.filter((c) => c.url.includes("/v1/orgs/"))).toHaveLength(1);
  });

  it("skips an org whose detail fails to load", async () => {
    mockFetch({ "/v1/listing/claims": { body: { claims: [claim("gone", "verified")] } } });
    expect(await listPublishableSources()).toEqual({ verifiedOrgCount: 1, sources: [] });
  });

  it("returns null when the claim lane is off", async () => {
    mockFetch({ "/v1/listing/claims": { status: 404, body: {} } });
    expect(await listPublishableSources()).toBeNull();
  });

  it("renders the workflow step with the source id and the secret reference", () => {
    const snippet = publishWorkflowSnippet("src_abc");
    expect(snippet).toContain("source: src_abc");
    expect(snippet).toContain("api-token: ${{ secrets.RELEASES_API_TOKEN }}");
  });
});
