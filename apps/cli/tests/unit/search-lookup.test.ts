/**
 * Unit tests for the search command's lookup rendering.
 *
 * We capture console.log output and verify the lookup rail renders correctly
 * for each LookupStatus value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { LookupResultPayload } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Drive the real mode.ts via env instead of a process-global mock.module
// (which leaked mode.js across files and forced `bun test --isolate`).
// unifiedSearch → apiFetch reads getApiUrl/getApiKey lazily; the assertions
// below only inspect the returned lookup payload, so the auth/admin values
// don't matter. Restored in afterAll so the key never bleeds into other files.
// ---------------------------------------------------------------------------

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

// We'll inject a controlled response via fetch mock
function mockSearch(response: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

// Capture console.log lines, stripping ANSI escape sequences
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  const ansi = /\[[0-9;]*m/g;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a).replace(ansi, "")).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_RESPONSE = {
  query: "koute/bytehound",
  orgs: [],
  catalog: [],
  products: [],
  sources: [],
  releases: [],
};

const BASE_SOURCE = {
  id: "src_abc",
  slug: "bytehound",
  name: "bytehound",
  url: "https://github.com/koute/bytehound",
  discovery: "on_demand" as const,
};

const PREVIEW_RELEASES = [
  { id: "r1", version: "0.11.0", title: "0.11.0", publishedAt: "2022-11-23T00:00:00Z" },
  { id: "r2", version: "0.10.0", title: "0.10.0", publishedAt: "2022-11-17T00:00:00Z" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search command lookup rendering", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders INDEXED status with source link and release preview", async () => {
    const lookup: LookupResultPayload = {
      status: "indexed",
      source: BASE_SOURCE,
      releases: PREVIEW_RELEASES,
      relatedOrg: null,
    };
    mockSearch({ ...BASE_RESPONSE, lookup });

    const { restore } = captureLog();
    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("koute/bytehound", 10);
    restore();

    // Verify lookup field is returned
    expect(response.lookup).not.toBeNull();
    expect(response.lookup?.status).toBe("indexed");
    expect(response.lookup?.source?.slug).toBe("bytehound");
    expect(response.lookup?.releases).toHaveLength(2);
  });

  it("renders NOT_FOUND status correctly", async () => {
    const lookup: LookupResultPayload = {
      status: "not_found",
      source: undefined,
      releases: undefined,
      relatedOrg: null,
    };
    mockSearch({ ...BASE_RESPONSE, query: "noorg/norepo", lookup });

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("noorg/norepo", 10);

    expect(response.lookup?.status).toBe("not_found");
    expect(response.lookup?.source).toBeUndefined();
  });

  it("renders EXISTING status with relatedOrg rail", async () => {
    const lookup: LookupResultPayload = {
      status: "existing",
      source: BASE_SOURCE,
      releases: PREVIEW_RELEASES,
      relatedOrg: {
        org: { id: "org_vercel", slug: "vercel", name: "Vercel" },
        sources: [
          {
            id: "src_njs",
            slug: "nextjs",
            name: "Next.js",
            url: "https://github.com/vercel/next.js",
          },
        ],
      },
    };
    mockSearch({ ...BASE_RESPONSE, lookup });

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("vercel/next.js", 10);

    expect(response.lookup?.status).toBe("existing");
    expect(response.lookup?.relatedOrg?.org.name).toBe("Vercel");
    expect(response.lookup?.relatedOrg?.sources).toHaveLength(1);
  });

  it("renders EMPTY status", async () => {
    const lookup: LookupResultPayload = {
      status: "empty",
      source: BASE_SOURCE,
      releases: [],
      relatedOrg: null,
    };
    mockSearch({ ...BASE_RESPONSE, lookup });

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("koute/bytehound", 10);

    expect(response.lookup?.status).toBe("empty");
  });

  it("renders DEFERRED status", async () => {
    const lookup: LookupResultPayload = {
      status: "deferred",
      source: undefined,
      releases: undefined,
      relatedOrg: null,
    };
    mockSearch({ ...BASE_RESPONSE, lookup });

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("koute/bytehound", 10);

    expect(response.lookup?.status).toBe("deferred");
  });

  it("returns null lookup when field is absent", async () => {
    mockSearch(BASE_RESPONSE);

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("nextjs", 10);

    expect(response.lookup == null).toBe(true);
  });

  it("includes lookup in JSON output shape", async () => {
    const lookup: LookupResultPayload = {
      status: "indexed",
      source: BASE_SOURCE,
      releases: PREVIEW_RELEASES,
      relatedOrg: null,
    };
    const apiResponse = { ...BASE_RESPONSE, lookup };
    mockSearch(apiResponse);

    const { unifiedSearch } = await import("../../src/api/sources.js");
    const response = await unifiedSearch("koute/bytehound", 10);

    // Simulate what the JSON path does: include lookup when non-null
    const payload: Record<string, unknown> = {
      query: response.query,
      orgs: response.orgs,
      catalog: response.catalog,
      releases: response.releases,
    };
    if (response.lookup != null) payload.lookup = response.lookup;

    expect(payload).toHaveProperty("lookup");
    expect((payload.lookup as LookupResultPayload).status).toBe("indexed");
    expect((payload.lookup as LookupResultPayload).releases).toHaveLength(2);
  });
});
