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
const { reextractAction } = await import("../../src/cli/commands/reextract.js");

const SAMPLE_REPORT = {
  source: { id: "src_x", slug: "my-source" },
  via: "snapshot",
  windows: 4,
  cappedAtWindow: false,
  droppedChars: 0,
  extracted: 42,
  deduped: 42,
  dateRange: { from: "2024-01-01T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" },
  found: 0,
  inserted: 0,
  dryRun: true,
  snapshot: {
    id: "raw_abc123",
    contentHash: "deadbeef",
    capturedAt: "2026-05-30T12:00:00.000Z",
    bytes: 81234,
    format: "markdown",
  },
};

// ── Client wire contract ───────────────────────────────────────────────────

describe("reextractSource client", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-reextract-client-"));
    process.env.RELEASES_RUN_DIR = dir;
    capturedUrl = "";
    capturedBody = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(SAMPLE_REPORT), {
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

  it("POSTs to /v1/workflows/reextract-source with the source ID and dryRun", async () => {
    const report = await client.reextractSource({ sourceId: "src_x", dryRun: true });
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/reextract-source");
    expect(capturedBody).toMatchObject({ sourceId: "src_x", dryRun: true });
    expect(report.via).toBe("snapshot");
    expect(report.snapshot?.id).toBe("raw_abc123");
  });

  it("forwards an explicit snapshotId", async () => {
    await client.reextractSource({ sourceId: "src_x", snapshotId: "raw_zzz", dryRun: true });
    expect(capturedBody).toMatchObject({ snapshotId: "raw_zzz" });
  });

  it("surfaces the endpoint's actionable message on a 410 expired snapshot", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "snapshot_expired",
          message: "Snapshot body gone from R2; likely past the 90-day lifecycle.",
        }),
        { status: 410, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    await expect(client.reextractSource({ sourceId: "src_x", dryRun: true })).rejects.toThrow(
      /90-day lifecycle/,
    );
  });
});

// ── Command behavior (resolve slug → src_… → POST body) ──────────────────────

describe("reextractAction", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let postBody: Record<string, unknown> | null = null;

  function mockResolveAndReextract() {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/workflows/reextract-source")) {
        postBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify(SAMPLE_REPORT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GET findSource(src_…) → a scrape source.
      return new Response(
        JSON.stringify({ id: "src_x", slug: "my-source", type: "scrape", name: "My Source" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-reextract-cmd-"));
    process.env.RELEASES_RUN_DIR = dir;
    postBody = null;
    mockResolveAndReextract();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-runs by default and forwards the resolved src_ ID", async () => {
    await reextractAction("src_x", {});
    expect(postBody).toMatchObject({ sourceId: "src_x", dryRun: true });
  });

  it("--no-dry-run (commander dryRun:false) writes", async () => {
    await reextractAction("src_x", { dryRun: false });
    expect((postBody as { dryRun?: boolean }).dryRun).toBe(false);
  });

  it("--commit also opts into writing", async () => {
    await reextractAction("src_x", { commit: true });
    expect((postBody as { dryRun?: boolean }).dryRun).toBe(false);
  });

  it("forwards --snapshot-id", async () => {
    await reextractAction("src_x", { snapshotId: "raw_pinned" });
    expect((postBody as { snapshotId?: string }).snapshotId).toBe("raw_pinned");
  });

  it("omits snapshotId when not given", async () => {
    await reextractAction("src_x", {});
    expect((postBody as { snapshotId?: string }).snapshotId).toBeUndefined();
  });

  it("forwards --max-windows as a number", async () => {
    await reextractAction("src_x", { maxWindows: "120" });
    expect((postBody as { maxWindows?: number }).maxWindows).toBe(120);
  });
});
