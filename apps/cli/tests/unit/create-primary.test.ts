import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the real mode.ts via env (a top-level mock.module leaks across files —
// see api-client.test.ts).
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

const { createSourceAction } = await import("../../src/cli/commands/create.js");

/**
 * #263 — `source create` could not mark a source as the org's primary changelog
 * in one step; `--primary` errored and callers had to follow up with
 * `source update --primary`. The REST create endpoint already accepts
 * `isPrimary`, so these tests pin that the flag travels in the create POST body.
 */
describe("source create --primary flag", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let postBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-create-primary-"));
    process.env.RELEASES_RUN_DIR = dir;
    postBody = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/sources")) {
        postBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "src_new",
            slug: "changelog",
            name: "Vitest",
            type: "github",
            url: "https://github.com/vitest-dev/vitest",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET findSourcesByUrls() → no existing source at this URL.
      if (url.includes("filterByUrls=true")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // GET findBlockedUrl() → not excluded (404 → null).
      return new Response("null", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends isPrimary: true in the create POST body when --primary is set", async () => {
    await createSourceAction("Vitest", {
      url: "https://github.com/vitest-dev/vitest",
      type: "github",
      primary: true,
    });
    expect(postBody).not.toBeNull();
    expect((postBody as { isPrimary?: boolean }).isPrimary).toBe(true);
  });

  it("omits isPrimary from the create POST body when --primary is not set", async () => {
    await createSourceAction("Vitest", {
      url: "https://github.com/vitest-dev/vitest",
      type: "github",
    });
    expect(postBody).not.toBeNull();
    expect((postBody as { isPrimary?: boolean }).isPrimary).toBeUndefined();
  });
});
