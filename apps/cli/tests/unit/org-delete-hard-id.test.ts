import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the real mode.ts via env rather than mocking the module (a top-level
// mock.module is process-global and leaks across files — see api-client.test.ts).
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

const { orgDeleteAction } = await import("../../src/cli/commands/org.js");

/**
 * #236 — `org delete --hard` always failed because the action resolved the
 * identifier to the org slug and put *that* in the DELETE path, but the server
 * rejects slugs on the destructive hard-delete path (requires the typed org_
 * ID). These tests pin the path the CLI sends.
 */
describe("orgDeleteAction --hard sends the typed org_ ID", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let deleteUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-orgdelete-"));
    process.env.RELEASES_RUN_DIR = dir;
    deleteUrl = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        deleteUrl = url;
        return new Response(JSON.stringify({ deleted: true, hard: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GET — findOrg(): an org that resolves to a different id and slug.
      return new Response(JSON.stringify({ id: "org_abc123", slug: "discord", name: "Discord" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts the org_ ID (not the slug) in the DELETE path on --hard", async () => {
    await orgDeleteAction("discord", { hard: true, yes: true });
    expect(deleteUrl).toBe("https://test.example.com/v1/orgs/org_abc123?hard=true");
    expect(deleteUrl).not.toContain("/v1/orgs/discord");
  });

  it("soft delete keeps using the slug", async () => {
    await orgDeleteAction("discord", { yes: true });
    expect(deleteUrl).toBe("https://test.example.com/v1/orgs/discord");
  });
});
