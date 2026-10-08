import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// Drive the real mode.ts via env (a top-level mock.module is process-global and
// leaks into other files — see api-client.test.ts for the rationale). apiFetch
// reads getApiUrl/getApiKey/isAdminMode lazily, so setting env before the
// dynamic import reproduces admin mode against a fake host.
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

const { updateSourceAction } = await import("../../src/cli/commands/update.js");

/**
 * Regression for #294: `source update <src_…> --render --json`.
 *
 * The source is addressed by a globally-unique `src_…` id, but its slug
 * (`release-notes`) collides across 8 orgs. The JSON-refresh step used to call
 * `findSource(displaySlug)` with the bare slug, which routes through the
 * cross-org bare-slug resolver and throws `AmbiguousSourceError` — *after* the
 * metadata PATCH already applied. The fix refreshes through the typed id, so
 * the ambiguous slug-listing endpoint is never touched.
 */
describe("source update --json refresh resolves by typed id (#294)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWrite: typeof process.stdout.write;
  let requestedUrls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWrite = process.stdout.write;
    requestedUrls = [];
    // Silence the --json payload so the test output stays clean.
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const source = {
      id: "src_abc",
      name: "Release Notes",
      slug: "release-notes",
      type: "scrape",
      url: "https://example.com/release-notes",
      orgId: "org_1",
      metadata: "{}",
    };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      requestedUrls.push(`${method} ${url}`);

      // The bare-slug listing endpoint returns *two* matches, so if anything
      // routes a refresh through the slug it would throw AmbiguousSourceError.
      if (url.includes("/v1/sources?slug=")) {
        return new Response(
          JSON.stringify([
            { id: "src_abc", slug: "release-notes", orgSlug: "org-a" },
            { id: "src_def", slug: "release-notes", orgSlug: "org-b" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET/PATCH /v1/sources/src_abc → the source row.
      return new Response(JSON.stringify(source), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  it("does not throw and never queries the ambiguous slug endpoint", async () => {
    await expect(
      updateSourceAction("src_abc", { render: true, json: true }),
    ).resolves.toBeUndefined();

    const hitSlugEndpoint = requestedUrls.some((u) => u.includes("/v1/sources?slug="));
    expect(hitSlugEndpoint).toBe(false);

    // The refresh GET went to the typed-id path.
    const refreshById = requestedUrls.filter(
      (u) => u === "GET https://test.example.com/v1/sources/src_abc",
    );
    expect(refreshById.length).toBeGreaterThanOrEqual(2); // initial findSource + json refresh
  });
});
