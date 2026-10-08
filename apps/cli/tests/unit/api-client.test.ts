import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceWithOrg } from "../../src/api/types.js";

// Drive the real mode.ts via env rather than mocking the module. A top-level
// mock.module("mode.js") is process-global — it leaks into every other test
// file (e.g. mode-credential.test.ts), which was the sole reason the suite
// needed `bun test --isolate`. apiFetch reads getApiUrl/getApiKey/isAdminMode
// lazily, so setting env before the tests run reproduces the old stub
// (getApiUrl → test URL, getApiKey → test-key, isAdminMode → true). Restored in
// afterAll so the key never bleeds into resolveCredential tests.
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

// The client.ts barrel was split into per-domain modules; merge them back into a
// single namespace so these characterization tests keep referencing `client.<fn>`.
const client = {
  ...(await import("../../src/api/core.js")),
  ...(await import("../../src/api/admin.js")),
  ...(await import("../../src/api/collections.js")),
  ...(await import("../../src/api/follows.js")),
  ...(await import("../../src/api/orgs.js")),
  ...(await import("../../src/api/products.js")),
  ...(await import("../../src/api/releases.js")),
  ...(await import("../../src/api/sources.js")),
  ...(await import("../../src/api/webhooks.js")),
};

function mockFetch(status: number, body: unknown = null) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as any;
}

// ---------------------------------------------------------------------------
// apiFetch 404 behavior — GET vs mutating methods
// ---------------------------------------------------------------------------

describe("apiFetch 404 handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null for GET 404 (findSource)", async () => {
    mockFetch(404);
    const result = await client.findSource("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for GET 404 (findOrg)", async () => {
    mockFetch(404);
    const result = await client.findOrg("nonexistent");
    expect(result).toBeNull();
  });

  it("surfaces the message from the standardized nested error envelope (POST 404)", async () => {
    // The API emits `{ error: { code, type, message } }`; the CLI must read
    // `error.message`, not a top-level `message`.
    mockFetch(404, { error: { code: "not_found", type: "not_found", message: "Org not found" } });
    await expect(client.addIgnoredUrl("https://example.com", "org_123")).rejects.toThrow(
      /API error \(404\) on POST .*: Org not found/,
    );
  });

  it("tolerates a legacy flat { message } body (DELETE 404)", async () => {
    mockFetch(404, { message: "Not Found" });
    await expect(client.deleteRelease("rel_123")).rejects.toThrow(
      /API error \(404\) on DELETE .*: Not Found/,
    );
  });

  it("throws on non-404 errors for GET, surfacing the envelope message", async () => {
    mockFetch(500, {
      error: { code: "internal_error", type: "internal", message: "Internal server error" },
    });
    await expect(client.findSource("test")).rejects.toThrow(
      /API error \(500\).*: Internal server error/,
    );
  });
});

// ---------------------------------------------------------------------------
// apiFetch mutation logging when fetch throws before a response
// ---------------------------------------------------------------------------

describe("apiFetch mutation logging on transport failure", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-apifetch-mut-"));
    process.env.RELEASES_RUN_DIR = dir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the attempt when fetch throws on a mutating request", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    await expect(client.addIgnoredUrl("https://example.com", "org_123")).rejects.toThrow(
      "ECONNREFUSED",
    );

    const line = JSON.parse(readFileSync(join(dir, "mutations.jsonl"), "utf-8").trim());
    expect(line.target).toBe("POST /v1/orgs/org_123/ignored-urls");
    expect(line.result).toContain("error");
    expect(line.result).toContain("ECONNREFUSED");
  });

  it("does not record when a GET throws (not a mutation)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    await expect(client.findOrg("nonexistent")).rejects.toThrow("ECONNREFUSED");
    expect(existsSync(join(dir, "mutations.jsonl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSourcesWithOrg — response shape conforms to shared SourceWithOrg type
// ---------------------------------------------------------------------------

describe("listSourcesWithOrg", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const apiRow: SourceWithOrg = {
    id: "src_abc123",
    name: "Next.js",
    slug: "nextjs",
    type: "github",
    url: "https://github.com/vercel/next.js",
    orgName: "Vercel",
    orgSlug: "vercel",
    productName: null,
    productSlug: null,
    isPrimary: true,
    isHidden: false,
    metadata: '{"feedUrl":"https://nextjs.org/feed.xml"}',
    releaseCount: 42,
    latestVersion: "15.3.0",
    latestDate: "2026-04-10T00:00:00Z",
    lastFetchedAt: "2026-04-15T12:00:00Z",
    fetchPriority: "normal",
    changeDetectedAt: null,
    consecutiveNoChange: 3,
    consecutiveErrors: 0,
    nextFetchAfter: null,
  };

  it("returns response preserving all SourceWithOrg fields", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([apiRow]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;

    const rows = await client.listSourcesWithOrg();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.id).toBe("src_abc123");
    expect(row.orgSlug).toBe("vercel");
    expect(row.orgName).toBe("Vercel");
    expect(row.latestVersion).toBe("15.3.0");
    expect(row.productName).toBeNull();
    expect(row.productSlug).toBeNull();
    expect(row.isPrimary).toBe(true);
    expect(row.isHidden).toBe(false);
    expect(row.consecutiveNoChange).toBe(3);
    expect(row.consecutiveErrors).toBe(0);
  });

  it("passes filter params as query string", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await client.listSourcesWithOrg({ orgSlug: "vercel", hasFeed: true, category: "ai" });
    expect(capturedUrl).toContain("orgSlug=vercel");
    expect(capturedUrl).toContain("has_feed=true");
    expect(capturedUrl).toContain("category=ai");
  });

  it("returns envelope with pagination totals when envelope=true", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          items: [apiRow],
          pagination: {
            page: 2,
            pageSize: 50,
            returned: 1,
            totalItems: 233,
            totalPages: 5,
            hasMore: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const res = await client.listSourcesWithOrg({ envelope: true, limit: 50, page: 2 });
    expect(capturedUrl).toContain("envelope=true");
    expect(res.items).toHaveLength(1);
    expect(res.pagination.totalItems).toBe(233);
    expect(res.pagination.hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listProducts — org-agnostic product listing backing `releases admin product
// list` with no org argument (releases-cli#259). Omitting orgId enumerates
// products across every org; getProductsByOrg unwraps the envelope for the
// single-org callers.
// ---------------------------------------------------------------------------

const productEnvelope = (items: unknown[], hasMore = false) => ({
  items,
  pagination: {
    page: 1,
    pageSize: items.length,
    returned: items.length,
    totalItems: items.length,
    totalPages: 1,
    hasMore,
  },
});

describe("listProducts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits orgId from the query string when no org is given", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(productEnvelope([])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await client.listProducts();
    expect(capturedUrl).toContain("/v1/products");
    expect(capturedUrl).not.toContain("orgId");
  });

  it("passes orgId, kind, limit, and page as query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(productEnvelope([])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await client.listProducts({ orgId: "org_abc", kind: "sdk", limit: 25, page: 3 });
    expect(capturedUrl).toContain("orgId=org_abc");
    expect(capturedUrl).toContain("kind=sdk");
    expect(capturedUrl).toContain("limit=25");
    expect(capturedUrl).toContain("page=3");
  });

  it("returns the paginated envelope from the worker", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(productEnvelope([{ id: "prod_1", orgId: "org_x" }], true)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;

    const res = await client.listProducts({ kind: "sdk" });
    expect(res.items).toHaveLength(1);
    expect(res.pagination.hasMore).toBe(true);
  });

  it("wraps the legacy bare-array shape in an envelope", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: "prod_1", orgId: "org_x" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;

    const res = await client.listProducts();
    expect(res.items).toHaveLength(1);
    expect(res.pagination.returned).toBe(1);
  });

  it("getProductsByOrg unwraps the envelope to a bare array", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(productEnvelope([{ id: "prod_1", orgId: "org_x" }])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const rows = await client.getProductsByOrg("org_x", { kind: "sdk" });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(capturedUrl).toContain("orgId=org_x");
    expect(capturedUrl).toContain("kind=sdk");
  });
});

// ---------------------------------------------------------------------------
// Embed backfill routes — paths moved from /v1/admin/embed/* to /v1/workflows/embed-*
// (monorepo #494); status endpoint stayed on /v1/admin/embed/status.
// ---------------------------------------------------------------------------

describe("embed backfill routes", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ processed: 0, remaining: 0, dryRun: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("embedReleases posts to /v1/workflows/embed-releases", async () => {
    await client.embedReleases({ dryRun: true });
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/embed-releases");
  });

  it("embedEntities posts to /v1/workflows/embed-entities", async () => {
    await client.embedEntities({ dryRun: true });
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/embed-entities");
  });

  it("embedChangelogs posts to /v1/workflows/embed-changelogs", async () => {
    await client.embedChangelogs({ dryRun: true });
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/embed-changelogs");
  });

  it("getEmbedStatus stays on /v1/admin/embed/status", async () => {
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          releases: { total: 0, embedded: 0, remaining: 0 },
          entities: { total: 0, embedded: 0, remaining: 0 },
          changelogs: { total: 0, embedded: 0, remaining: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;
    await client.getEmbedStatus();
    expect(capturedUrl).toBe("https://test.example.com/v1/admin/embed/status");
  });
});

// ---------------------------------------------------------------------------
// Time-window (since/until) query-param passthrough
// ---------------------------------------------------------------------------

describe("since/until query params", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function captureWith(body: unknown) {
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;
  }

  it("unifiedSearch forwards since and until", async () => {
    captureWith({ orgs: [], catalog: [], releases: [], collections: [] });
    await client.unifiedSearch("q", 10, { since: "90d", until: "2026-05-01" });
    expect(capturedUrl).toContain("since=90d");
    expect(capturedUrl).toContain("until=2026-05-01");
  });

  it("unifiedSearch omits since/until when not supplied", async () => {
    captureWith({ orgs: [], catalog: [], releases: [], collections: [] });
    await client.unifiedSearch("q", 10);
    expect(capturedUrl).not.toContain("since=");
    expect(capturedUrl).not.toContain("until=");
  });

  it("getLatestReleases forwards since and until", async () => {
    captureWith({ releases: [] });
    await client.getLatestReleases({ count: 10, since: "30d", until: "2026-05-01" });
    expect(capturedUrl).toContain("since=30d");
    expect(capturedUrl).toContain("until=2026-05-01");
  });

  it("unifiedSearch forwards category and collection", async () => {
    captureWith({ orgs: [], catalog: [], releases: [], collections: [] });
    await client.unifiedSearch("q", 10, {
      category: "developer-tools",
      collection: "coding-agents",
    });
    expect(capturedUrl).toContain("category=developer-tools");
    expect(capturedUrl).toContain("collection=coding-agents");
  });

  it("unifiedSearch omits category/collection when not supplied", async () => {
    captureWith({ orgs: [], catalog: [], releases: [], collections: [] });
    await client.unifiedSearch("q", 10);
    expect(capturedUrl).not.toContain("category=");
    expect(capturedUrl).not.toContain("collection=");
  });
});

// ---------------------------------------------------------------------------
// Product cross-source feed
// ---------------------------------------------------------------------------

describe("getProductReleases", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function captureWith(status: number, body: unknown) {
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;
  }

  it("hits the org feed with product + limit and maps the rows + cursor", async () => {
    captureWith(200, {
      releases: [
        {
          id: "rel_1",
          version: "1.2.0",
          title: "Shipped X",
          summary: "Did the thing",
          titleGenerated: "X is here",
          titleShort: "X",
          contentChars: 42,
          contentTokens: 12,
          publishedAt: "2026-05-20T00:00:00.000Z",
          url: "https://example.com/x",
          media: [],
          // extra fields the org feed carries but the CLI ignores:
          type: "feature",
          prerelease: false,
          coverageCount: 0,
          source: { slug: "turborepo", name: "Turborepo", type: "github" },
        },
      ],
      pagination: { nextCursor: "CURSOR_2", limit: 20 },
    });

    const res = await client.getProductReleases({
      orgRef: "vercel",
      product: "turborepo",
      count: 20,
    });

    expect(capturedUrl).toContain("/v1/orgs/vercel/releases?");
    expect(capturedUrl).toContain("product=turborepo");
    expect(capturedUrl).toContain("limit=20");
    expect(res).not.toBeNull();
    expect(res!.nextCursor).toBe("CURSOR_2");
    expect(res!.releases).toHaveLength(1);
    const row = res!.releases[0];
    expect(row.id).toBe("rel_1");
    expect(row.sourceName).toBe("Turborepo");
    expect(row.sourceSlug).toBe("turborepo");
    expect(row.titleShort).toBe("X");
    expect(row.contentTokens).toBe(12);
  });

  it("forwards cursor, since, and until when supplied", async () => {
    captureWith(200, { releases: [], pagination: { nextCursor: null, limit: 20 } });
    await client.getProductReleases({
      orgRef: "vercel",
      product: "turborepo",
      count: 20,
      cursor: "CURSOR_1",
      since: "30d",
      until: "2026-05-01",
    });
    expect(capturedUrl).toContain("cursor=CURSOR_1");
    expect(capturedUrl).toContain("since=30d");
    expect(capturedUrl).toContain("until=2026-05-01");
  });

  it("returns null when the org/product 404s", async () => {
    captureWith(404, { error: "not_found" });
    const res = await client.getProductReleases({
      orgRef: "vercel",
      product: "nope",
      count: 20,
    });
    expect(res).toBeNull();
  });
});

describe("resolveProductFeedTarget", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("splits an org/slug coordinate locally without a round-trip", async () => {
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as any;
    const target = await client.resolveProductFeedTarget("vercel/turborepo");
    expect(target).toEqual({ orgRef: "vercel", product: "turborepo" });
    expect(capturedUrl).toBe(""); // no network call for the coordinate form
  });

  it("bounces a bare slug through the product-by-slug lookup", async () => {
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ productId: "prod_x", productSlug: "turborepo", orgSlug: "vercel" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;
    const target = await client.resolveProductFeedTarget("turborepo");
    expect(capturedUrl).toContain("/v1/lookups/product-by-slug?slug=turborepo");
    expect(target).toEqual({ orgRef: "vercel", product: "turborepo" });
  });

  it("returns null when a bare slug doesn't resolve", async () => {
    globalThis.fetch = (async () => new Response("null", { status: 404 })) as any;
    const target = await client.resolveProductFeedTarget("ghost");
    expect(target).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findSource bare-slug ambiguity (#264)
//
// Source slugs are unique per-org, not globally. A bare slug that exists under
// more than one org must error and list candidates instead of silently
// resolving to the oldest match. `src_…` ids and `org/slug` coordinates stay
// the unambiguous escape hatches and must NOT trigger the enumeration.
// ---------------------------------------------------------------------------

const sourceRow = (id: string, slug: string, orgSlug: string): SourceWithOrg => ({
  id,
  name: slug,
  slug,
  type: "scrape",
  url: `https://${orgSlug}.test/${slug}`,
  orgName: orgSlug,
  orgSlug,
  productName: null,
  productSlug: null,
  isPrimary: false,
  isHidden: false,
  metadata: null,
  releaseCount: 0,
  latestVersion: null,
  latestDate: null,
  lastFetchedAt: null,
  fetchPriority: "normal",
  changeDetectedAt: null,
  consecutiveNoChange: 0,
  consecutiveErrors: 0,
  nextFetchAfter: null,
  lastPolledAt: null,
  medianGapDays: null,
  lastRetieredAt: null,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("findSource bare-slug ambiguity (#264)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const json = jsonResponse;

  it("throws AmbiguousSourceError with all candidates when a bare slug matches >1 org", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/sources?")) {
        return json([sourceRow("src_a", "blog", "vitest"), sourceRow("src_b", "blog", "hashnode")]);
      }
      return json(null, 404);
    }) as any;

    let caught: unknown;
    try {
      await client.findSource("blog");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(client.AmbiguousSourceError);
    const err = caught as InstanceType<typeof client.AmbiguousSourceError>;
    expect(err.slug).toBe("blog");
    // Candidate order mirrors the server's row order (preserved through the
    // filter + map in resolveSourceTarget).
    expect(err.candidates.map((c) => c.orgSlug)).toEqual(["vitest", "hashnode"]);
    expect(err.candidates.map((c) => c.id)).toEqual(["src_a", "src_b"]);
  });

  it("resolves a bare slug that matches exactly one source", async () => {
    let enumUrl = "";
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/sources?")) {
        enumUrl = url;
        return json([sourceRow("src_only", "blog", "vitest")]);
      }
      // Second hop: hydrate the resolved source by its typed id.
      return json({ ...sourceRow("src_only", "blog", "vitest"), orgId: "org_vitest" });
    }) as any;

    const found = await client.findSource("blog");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("src_only");
    // Enumeration is an exact-slug match that includes hidden sources.
    expect(enumUrl).toContain("slug=blog");
    expect(enumUrl).toContain("include_hidden=true");
  });

  it("returns null when a bare slug matches no source", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/sources?")) return json([]);
      return json(null, 404);
    }) as any;
    expect(await client.findSource("ghost")).toBeNull();
  });

  it("passes a src_… id straight through without enumerating by slug", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return json(sourceRow("src_x", "blog", "vitest"));
    }) as any;

    await client.findSource("src_x");
    expect(urls.some((u) => u.includes("/v1/sources/src_x"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/sources?"))).toBe(false);
  });

  it("ignores non-matching rows from an API build that doesn't honor ?slug=", async () => {
    // Older server returns an unfiltered page; the client re-applies the exact
    // slug match so a single true match still resolves (no false ambiguity).
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/sources?")) {
        return json([
          sourceRow("src_a", "blog", "vitest"),
          sourceRow("src_b", "changelog", "hashnode"),
          sourceRow("src_c", "docs", "acme"),
        ]);
      }
      return json({ ...sourceRow("src_a", "blog", "vitest"), orgId: "org_vitest" });
    }) as any;

    const found = await client.findSource("blog");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("src_a");
  });

  it("splits an org/slug coordinate locally without enumerating by slug", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return json(sourceRow("src_y", "blog", "vitest"));
    }) as any;

    await client.findSource("vitest/blog");
    expect(urls.some((u) => u.includes("/v1/orgs/vitest/sources/blog"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/sources?"))).toBe(false);
  });
});

const rawFetchLogRow = (id: string) => ({
  id,
  sourceId: "src_a1",
  releasesFound: 0,
  releasesInserted: 0,
  durationMs: 1200,
  status: "no_change",
  error: null,
  rawContent: null,
  createdAt: "2026-06-01T00:00:00.000Z",
});

describe("getFetchLogs activeSession overlay (#1360)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const rawRow = rawFetchLogRow;

  it("requests envelope=true and returns the activeSession when a source is given", async () => {
    let calledUrl = "";
    const active = { sessionId: "ma-run", status: "running", startedAt: 1000, lastUpdatedAt: 2000 };
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({
        items: [rawRow("fl_1")],
        activeSession: active,
        pagination: { page: 1, pageSize: 20, returned: 1, hasMore: false },
      });
    }) as any;

    const result = await client.getFetchLogs({ source: "src_a1", limit: 20 });

    expect(calledUrl).toContain("source=src_a1");
    expect(calledUrl).toContain("envelope=true");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].id).toBe("fl_1");
    expect(result.activeSession).toEqual(active);
  });

  it("returns a null activeSession when the envelope reports none", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ items: [rawRow("fl_1")], activeSession: null, pagination: {} })) as any;

    const result = await client.getFetchLogs({ source: "src_a1", limit: 20 });

    expect(result.activeSession).toBeNull();
    expect(result.logs).toHaveLength(1);
  });

  it("requests the envelope for the global list too, with a null activeSession", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      // The global (no-source) list degrades to just items — no activeSession.
      return jsonResponse({ items: [rawRow("fl_1"), rawRow("fl_2")], pagination: {} });
    }) as any;

    const result = await client.getFetchLogs({ limit: 20 });

    expect(calledUrl).toContain("envelope=true");
    expect(calledUrl).not.toContain("source=");
    expect(result.logs).toHaveLength(2);
    expect(result.activeSession).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMonthlySummary — null-safe 404 handling (#002)
// ---------------------------------------------------------------------------

describe("getMonthlySummary", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined from getMonthlySummary on GET 404", async () => {
    mockFetch(404);
    const result = await client.getMonthlySummary("src_123", 2026, 6);
    expect(result).toBeUndefined();
  });

  it("returns the first row on 200", async () => {
    const summaryRow = { id: "sum_1", sourceId: "src_123", year: 2026, month: 6 } as any;
    mockFetch(200, [summaryRow]);
    const result = await client.getMonthlySummary("src_123", 2026, 6);
    expect(result).toEqual(summaryRow);
  });
});

describe("apiFetch transport error context", () => {
  it("wraps transport errors with endpoint context", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    try {
      await expect(client.findSource("anything")).rejects.toThrow(
        /API request failed on GET .*: ECONNREFUSED/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Characterization tests: request contract (path + method + body + result)
// for previously-untested exported functions.
// ---------------------------------------------------------------------------

function captureFetch(status: number, body: unknown = null) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
  return calls;
}

// ── Admin roles ─────────────────────────────────────────────────────────────

describe("admin roles", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("getUserRole GETs /v1/admin/users/role?email=…", async () => {
    const calls = captureFetch(200, { userId: "u1", email: "a@b.com", role: "curator" });
    const result = await client.getUserRole({ email: "a@b.com" });
    expect(calls[0].url).toContain("/v1/admin/users/role");
    expect(calls[0].url).toContain("email=a%40b.com");
    expect(calls[0].init?.method).toBeUndefined(); // GET
    expect(result?.role).toBe("curator");
  });

  it("setUserRole PATCHes /v1/admin/users/role with email+role body", async () => {
    const calls = captureFetch(200, {
      userId: "u1",
      email: "a@b.com",
      role: "admin",
      previousRole: null,
    });
    const result = await client.setUserRole({ email: "a@b.com" }, "admin");
    expect(calls[0].url).toContain("/v1/admin/users/role");
    expect(calls[0].init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.email).toBe("a@b.com");
    expect(body.role).toBe("admin");
    expect(result.previousRole).toBeNull();
  });

  it("listUserRoles GETs /v1/admin/users/roles and unwraps the envelope", async () => {
    const calls = captureFetch(200, {
      users: [{ userId: "u1", email: "a@b.com", role: "curator" }],
    });
    const result = await client.listUserRoles();
    expect(calls[0].url).toContain("/v1/admin/users/roles");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].role).toBe("curator");
  });

  it("listUserRoles throws on 404 instead of returning null", async () => {
    captureFetch(404);
    await expect(client.listUserRoles()).rejects.toThrow(/listUserRoles: 404/);
  });
});

// ── OAuth clients ────────────────────────────────────────────────────────────

describe("OAuth clients", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseClient = {
    clientId: "reloc_abc",
    name: "My App",
    redirectUris: ["https://app.example.com/callback"],
    scopes: ["read"],
    trusted: false,
    disabled: false,
    public: false,
    type: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
  };

  it("createOAuthClient POSTs to /v1/admin/oauth/clients", async () => {
    const calls = captureFetch(201, { ...baseClient, clientSecret: "reloc_secret" });
    const result = await client.createOAuthClient({
      name: "My App",
      redirectUris: ["https://app.example.com/callback"],
      scopes: ["read"],
    });
    expect(calls[0].url).toContain("/v1/admin/oauth/clients");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.name).toBe("My App");
    expect(body.scopes).toEqual(["read"]);
    expect(result.clientSecret).toBe("reloc_secret");
  });

  it("listOAuthClients GETs /v1/admin/oauth/clients and unwraps envelope", async () => {
    const calls = captureFetch(200, { clients: [baseClient] });
    const result = await client.listOAuthClients();
    expect(calls[0].url).toContain("/v1/admin/oauth/clients");
    expect(calls[0].init?.method).toBeUndefined();
    expect(result[0].clientId).toBe("reloc_abc");
  });

  it("updateOAuthClient PATCHes /v1/admin/oauth/clients/:id", async () => {
    const calls = captureFetch(200, { ...baseClient, disabled: true });
    const result = await client.updateOAuthClient("reloc_abc", { disabled: true });
    expect(calls[0].url).toContain("/v1/admin/oauth/clients/reloc_abc");
    expect(calls[0].init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.disabled).toBe(true);
    expect(result.disabled).toBe(true);
  });

  it("rotateOAuthClientSecret POSTs to …/rotate-secret", async () => {
    const calls = captureFetch(200, { clientId: "reloc_abc", clientSecret: "newSecret" });
    const result = await client.rotateOAuthClientSecret("reloc_abc");
    expect(calls[0].url).toContain("/v1/admin/oauth/clients/reloc_abc/rotate-secret");
    expect(calls[0].init?.method).toBe("POST");
    expect(result.clientSecret).toBe("newSecret");
  });

  it("deleteOAuthClient DELETEs /v1/admin/oauth/clients/:id", async () => {
    const calls = captureFetch(200, { clientId: "reloc_abc", deleted: true });
    const result = await client.deleteOAuthClient("reloc_abc");
    expect(calls[0].url).toContain("/v1/admin/oauth/clients/reloc_abc");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(result.deleted).toBe(true);
  });
});

// ── Webhook subscriptions ────────────────────────────────────────────────────

describe("webhook subscriptions", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseSub = {
    id: "wh_1",
    orgId: "org_x",
    url: "https://example.com/hook",
    sourceId: null,
    enabled: true,
    description: null,
    secretVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMsg: null,
    consecutiveFailures: 0,
    disabledReason: null,
  };

  it("createWebhookSubscription POSTs to /v1/webhooks", async () => {
    const calls = captureFetch(201, { ...baseSub, signingKey: "whs_key" });
    const result = await client.createWebhookSubscription({
      orgId: "org_x",
      url: "https://example.com/hook",
    });
    expect(calls[0].url).toContain("/v1/webhooks");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.orgId).toBe("org_x");
    expect(body.url).toBe("https://example.com/hook");
    expect(result.signingKey).toBe("whs_key");
  });

  it("listWebhookSubscriptions GETs /v1/webhooks?org=… and unwraps", async () => {
    const calls = captureFetch(200, { subscriptions: [baseSub] });
    const result = await client.listWebhookSubscriptions("org_x");
    expect(calls[0].url).toContain("/v1/webhooks");
    expect(calls[0].url).toContain("org=org_x");
    expect(result[0].id).toBe("wh_1");
  });

  it("rotateWebhookSecret POSTs to …/rotate-secret", async () => {
    const calls = captureFetch(200, { secretVersion: 2, signingKey: "new_key" });
    const result = await client.rotateWebhookSecret("wh_1");
    expect(calls[0].url).toContain("/v1/webhooks/wh_1/rotate-secret");
    expect(calls[0].init?.method).toBe("POST");
    expect(result.secretVersion).toBe(2);
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

describe("sessions", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listSessions GETs /v1/sessions and passes query params", async () => {
    const calls = captureFetch(200, { items: [], pagination: {} });
    await client.listSessions({ limit: 10, type: "discovery", status: "running" });
    expect(calls[0].url).toContain("/v1/sessions");
    expect(calls[0].url).toContain("limit=10");
    expect(calls[0].url).toContain("type=discovery");
    expect(calls[0].url).toContain("status=running");
    expect(calls[0].init?.method).toBeUndefined();
  });

  it("getSession GETs /v1/sessions/:id", async () => {
    const calls = captureFetch(200, { id: "ma_1", status: "complete" });
    const result = await client.getSession("ma_1");
    expect(calls[0].url).toContain("/v1/sessions/ma_1");
    expect(calls[0].init?.method).toBeUndefined();
    expect((result as any).id).toBe("ma_1");
  });

  it("cancelSession POSTs to /v1/sessions/:id/cancel", async () => {
    const calls = captureFetch(200, { ok: true });
    const result = await client.cancelSession("ma_1");
    expect(calls[0].url).toContain("/v1/sessions/ma_1/cancel");
    expect(calls[0].init?.method).toBe("POST");
    expect(result.ok).toBe(true);
  });
});

// ── Backfill / re-extract ────────────────────────────────────────────────────

describe("backfill and re-extract", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const syncReport = {
    source: { id: "src_1", slug: "blog" },
    via: "fetch" as const,
    windows: 2,
    cappedAtWindow: false,
    droppedChars: 0,
    extracted: 5,
    deduped: 5,
    dateRange: { from: null, to: null },
    found: 5,
    inserted: 3,
    dryRun: false,
  };

  it("backfillSource POSTs to /v1/workflows/backfill-source with sourceId+dryRun", async () => {
    const calls = captureFetch(200, syncReport);
    const result = await client.backfillSource({ sourceId: "src_1", dryRun: true });
    expect(calls[0].url).toContain("/v1/workflows/backfill-source");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.sourceId).toBe("src_1");
    expect(body.dryRun).toBe(true);
    expect(client.isBackfillAsync(result as any)).toBe(false);
  });

  it("backfillSource returns async shape when 202 responds with instanceId", async () => {
    const asyncResp = { instanceId: "inst_1", async: true, statusUrl: "https://api/status/inst_1" };
    const calls = captureFetch(200, asyncResp);
    const result = await client.backfillSource({ sourceId: "src_1", dryRun: false });
    expect(client.isBackfillAsync(result as any)).toBe(true);
    const async_ = result as typeof asyncResp;
    expect(async_.instanceId).toBe("inst_1");
    void calls; // captured for symmetry
  });

  it("getBackfillStatus GETs /v1/workflows/backfill-source/status/:id", async () => {
    const calls = captureFetch(200, {
      instanceId: "inst_1",
      status: "complete",
      output: syncReport,
    });
    const result = await client.getBackfillStatus("inst_1");
    expect(calls[0].url).toContain("/v1/workflows/backfill-source/status/inst_1");
    expect(calls[0].init?.method).toBeUndefined();
    expect(result?.status).toBe("complete");
  });

  it("reextractSource POSTs to /v1/workflows/reextract-source", async () => {
    const calls = captureFetch(200, { ...syncReport, via: "snapshot" });
    const result = await client.reextractSource({ sourceId: "src_1", dryRun: true });
    expect(calls[0].url).toContain("/v1/workflows/reextract-source");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.sourceId).toBe("src_1");
    expect(body.dryRun).toBe(true);
    expect(result.via).toBe("snapshot");
  });
});

// ── Batch overview ───────────────────────────────────────────────────────────

// ── Media assets ─────────────────────────────────────────────────────────────

describe("media assets", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("insertMediaAssets POSTs to /v1/media/assets with assets array", async () => {
    const calls = captureFetch(200, { inserted: 2 });
    const result = await client.insertMediaAssets([
      {
        releaseId: "rel_1",
        url: "https://cdn.test/img.png",
        contentHash: "abc",
        mimeType: "image/png",
        bytes: 100,
      } as any,
    ]);
    expect(calls[0].url).toContain("/v1/media/assets");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(Array.isArray(body.assets)).toBe(true);
    expect(result.inserted).toBe(2);
  });

  it("queryReleasesWithMedia GETs /v1/releases?hasMedia=true&fields=…", async () => {
    const calls = captureFetch(200, [{ id: "rel_1", sourceId: "src_1", media: "[]" }]);
    const result = await client.queryReleasesWithMedia();
    expect(calls[0].url).toContain("/v1/releases");
    expect(calls[0].url).toContain("hasMedia=true");
    expect(calls[0].url).toContain("fields=id");
    expect(result[0].id).toBe("rel_1");
  });
});

// ── URL evaluation ───────────────────────────────────────────────────────────

describe("evaluateUrl", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs /v1/evaluate?url=… with encoded URL", async () => {
    const calls = captureFetch(200, { recommendation: "include", confidence: 0.9 });
    const result = await client.evaluateUrl("https://example.com/changelog");
    expect(calls[0].url).toContain("/v1/evaluate");
    expect(calls[0].url).toContain("url=https%3A%2F%2Fexample.com%2Fchangelog");
    expect(calls[0].init?.method).toBeUndefined();
    expect((result as any).recommendation).toBe("include");
  });
});

// ── updateSourceMeta ─────────────────────────────────────────────────────────

describe("updateSourceMeta", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("merges new keys into existing metadata and PATCHes /v1/sources/:id", async () => {
    const calls = captureFetch(200, {});
    const source = { id: "src_1", metadata: JSON.stringify({ existing: "value" }) } as any;
    await client.updateSourceMeta(source, { newKey: "newVal" });
    expect(calls[0].url).toContain("/v1/sources/src_1");
    expect(calls[0].init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0].init!.body as string);
    const merged = JSON.parse(body.metadata);
    expect(merged.existing).toBe("value");
    expect(merged.newKey).toBe("newVal");
  });

  it("removes keys set to undefined from metadata", async () => {
    const calls = captureFetch(200, {});
    const source = { id: "src_1", metadata: JSON.stringify({ keep: "yes", remove: "old" }) } as any;
    await client.updateSourceMeta(source, { remove: undefined });
    const body = JSON.parse(calls[0].init!.body as string);
    const merged = JSON.parse(body.metadata);
    expect(merged.keep).toBe("yes");
    expect("remove" in merged).toBe(false);
  });
});

// ── createProduct ────────────────────────────────────────────────────────────

describe("createProduct", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /v1/products with orgId, name, and opts", async () => {
    const calls = captureFetch(201, {
      id: "prod_1",
      orgId: "org_x",
      name: "My Product",
      slug: "my-product",
    });
    const result = await client.createProduct("org_x", "My Product", {
      slug: "my-product",
      kind: "sdk",
    });
    expect(calls[0].url).toContain("/v1/products");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.orgId).toBe("org_x");
    expect(body.name).toBe("My Product");
    expect(body.slug).toBe("my-product");
    expect(body.kind).toBe("sdk");
    expect(result.id).toBe("prod_1");
  });
});

// ── suppressRelease / unsuppressRelease ──────────────────────────────────────

describe("release suppression", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("suppressRelease POSTs to /v1/releases/:id/suppress with reason", async () => {
    const calls = captureFetch(200, { suppressed: true });
    const result = await client.suppressRelease("rel_1", "spam");
    expect(calls[0].url).toContain("/v1/releases/rel_1/suppress");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.reason).toBe("spam");
    expect(result).toBe(true);
  });

  it("unsuppressRelease POSTs to /v1/releases/:id/unsuppress", async () => {
    const calls = captureFetch(200, { unsuppressed: true });
    const result = await client.unsuppressRelease("rel_1");
    expect(calls[0].url).toContain("/v1/releases/rel_1/unsuppress");
    expect(calls[0].init?.method).toBe("POST");
    expect(result).toBe(true);
  });

  it("deleteReleasesBatch DELETEs /v1/releases/batch with releaseIds", async () => {
    const calls = captureFetch(200, { deleted: 2 });
    const result = await client.deleteReleasesBatch(["rel_1", "rel_2"]);
    expect(calls[0].url).toContain("/v1/releases/batch");
    expect(calls[0].init?.method).toBe("DELETE");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.releaseIds).toEqual(["rel_1", "rel_2"]);
    expect(result.deleted).toBe(2);
  });

  it("batchSuppressReleases POSTs /v1/releases/batch-suppress", async () => {
    const calls = captureFetch(200, { updated: 3 });
    const result = await client.batchSuppressReleases(["rel_1", "rel_2", "rel_3"], true, "spam");
    expect(calls[0].url).toContain("/v1/releases/batch-suppress");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.releaseIds).toEqual(["rel_1", "rel_2", "rel_3"]);
    expect(body.suppressed).toBe(true);
    expect(body.reason).toBe("spam");
    expect(result.updated).toBe(3);
  });
});

// ── follows ──────────────────────────────────────────────────────────────────

describe("follows", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("addFollow POSTs to /v1/me/follows with targetType+targetId", async () => {
    const calls = captureFetch(201, { ok: true, action: "created" });
    await client.addFollow("org", "org_x");
    expect(calls[0].url).toContain("/v1/me/follows");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.targetType).toBe("org");
    expect(body.targetId).toBe("org_x");
  });

  it("removeFollow DELETEs /v1/me/follows/:type/:id", async () => {
    const calls = captureFetch(200, { ok: true, action: "removed" });
    await client.removeFollow("org", "org_x");
    expect(calls[0].url).toContain("/v1/me/follows/org/org_x");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("listMyFollows GETs /v1/me/follows and unwraps envelope", async () => {
    const calls = captureFetch(200, {
      follows: [{ id: "f_1", targetType: "org", targetId: "org_x" }],
    });
    const result = await client.listMyFollows();
    expect(calls[0].url).toContain("/v1/me/follows");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].targetType).toBe("org");
  });
});
