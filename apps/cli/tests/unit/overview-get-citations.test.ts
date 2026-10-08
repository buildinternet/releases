/**
 * Unit tests for `overview get` surfacing inline citations (#228).
 *
 * The org overview GET returns the knowledge page plus a `citations` array
 * ordered by character position. `getOverview` must carry it through so
 * `overview get` can report a count that matches what `overview update`
 * echoed. We mock `globalThis.fetch` (same approach as search-lookup) and
 * assert the parsed shape, then simulate the JSON payload the action builds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { type OverviewCitation } from "../../src/api/types.js";

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

function mockGet(response: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

const BASE_PAGE = {
  scope: "org",
  orgSlug: "railway",
  content: "Railway shipped a bunch.",
  releaseCount: 42,
  generatedAt: "2026-05-25T00:00:00Z",
  updatedAt: "2026-05-25T00:00:00Z",
  lastContributingReleaseAt: "2026-05-24T00:00:00Z",
};

const CITATIONS: OverviewCitation[] = [
  {
    startIndex: 0,
    endIndex: 7,
    sourceUrl: "https://railway.app/changelog/a",
    title: "A",
    citedText: "Railway",
  },
  {
    startIndex: 8,
    endIndex: 15,
    sourceUrl: "https://railway.app/changelog/b",
    title: "B",
    citedText: "shipped",
  },
];

describe("getOverview citations (#228)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("carries the citations array through from the org overview GET", async () => {
    mockGet({ ...BASE_PAGE, citations: CITATIONS });

    const { getOverview } = await import("../../src/api/sources.js");
    const overview = await getOverview("org", "railway");

    expect(overview).not.toBeNull();
    expect(overview?.citations).toHaveLength(2);
    expect(overview?.citations?.[0]?.sourceUrl).toBe("https://railway.app/changelog/a");
  });

  it("treats a citationless page as zero citations (count derivation is safe)", async () => {
    mockGet({ ...BASE_PAGE }); // no `citations` field — pages pre-#846

    const { getOverview } = await import("../../src/api/sources.js");
    const overview = await getOverview("org", "railway");

    const citations = overview?.citations ?? [];
    expect(citations).toHaveLength(0);
  });

  it("builds the --json payload shape with citationCount matching the array", async () => {
    mockGet({ ...BASE_PAGE, citations: CITATIONS });

    const { getOverview } = await import("../../src/api/sources.js");
    const overview = await getOverview("org", "railway");
    const citations = overview?.citations ?? [];

    // Mirror what overviewGetAction's --json path emits.
    const payload = {
      org: "railway",
      content: overview?.content,
      releaseCount: overview?.releaseCount,
      citationCount: citations.length,
      citations,
    };

    expect(payload.citationCount).toBe(2);
    expect(payload.citations).toHaveLength(2);
    expect(payload).toHaveProperty("citationCount");
  });

  it("returns null when no overview exists yet (endpoint returns 200 + null)", async () => {
    // The overview GET handler returns `c.json(null)` (HTTP 200, null body) when
    // the org or page is missing — it does not 404 — so this is the real shape.
    mockGet(null);

    const { getOverview } = await import("../../src/api/sources.js");
    const overview = await getOverview("org", "railway");

    expect(overview).toBeNull();
  });

  it("returns null on a 404 too (generic apiFetch GET-404 → null path)", async () => {
    mockGet({ message: "Not found" }, 404);

    const { getOverview } = await import("../../src/api/sources.js");
    const overview = await getOverview("org", "nope");

    expect(overview).toBeNull();
  });
});
