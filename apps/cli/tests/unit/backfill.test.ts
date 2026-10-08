import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { backfillAction, backfillStatusAction } = await import("../../src/cli/commands/backfill.js");

const SAMPLE_REPORT = {
  source: { id: "src_x", slug: "my-source" },
  via: "supplied",
  windows: 7,
  cappedAtWindow: false,
  droppedChars: 0,
  extracted: 119,
  deduped: 119,
  dateRange: { from: "2023-02-01T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" },
  found: 0,
  inserted: 0,
  dryRun: true,
};

// ── Client wire contract ───────────────────────────────────────────────────

describe("backfillSource client", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-backfill-client-"));
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

  it("POSTs to /v1/workflows/backfill-source with the source ID and dryRun", async () => {
    const report = await client.backfillSource({ sourceId: "src_x", dryRun: true });
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/backfill-source");
    expect(capturedBody).toMatchObject({ sourceId: "src_x", dryRun: true });
    expect(client.isBackfillAsync(report)).toBe(false);
    if (!client.isBackfillAsync(report)) expect(report.extracted).toBe(119);
  });

  it("surfaces the endpoint's actionable message on a 400", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "bad_request",
          message: "Backfill supports scrape sources; this source is type=feed",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )) as unknown as typeof globalThis.fetch;
    await expect(client.backfillSource({ sourceId: "src_x", dryRun: true })).rejects.toThrow(
      /type=feed/,
    );
  });
});

// ── Command behavior (resolve slug → src_… → POST body) ──────────────────────

describe("backfillAction", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let postBody: Record<string, unknown> | null = null;

  function mockResolveAndBackfill() {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/workflows/backfill-source")) {
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
    dir = mkdtempSync(join(tmpdir(), "rel-backfill-cmd-"));
    process.env.RELEASES_RUN_DIR = dir;
    postBody = null;
    mockResolveAndBackfill();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-runs by default and forwards the resolved src_ ID", async () => {
    await backfillAction("src_x", {});
    expect(postBody).toMatchObject({ sourceId: "src_x", dryRun: true });
  });

  it("--no-dry-run (commander dryRun:false) writes", async () => {
    await backfillAction("src_x", { dryRun: false });
    expect((postBody as { dryRun?: boolean }).dryRun).toBe(false);
  });

  it("--commit also opts into writing", async () => {
    await backfillAction("src_x", { commit: true });
    expect((postBody as { dryRun?: boolean }).dryRun).toBe(false);
  });

  it("forwards --max-windows as a number", async () => {
    await backfillAction("src_x", { maxWindows: "100" });
    expect((postBody as { maxWindows?: number }).maxWindows).toBe(100);
  });

  it("omits maxWindows when not given", async () => {
    await backfillAction("src_x", {});
    expect((postBody as { maxWindows?: number }).maxWindows).toBeUndefined();
  });

  it("sends --markdown-file content as the markdown body field", async () => {
    const file = join(dir, "page.md");
    writeFileSync(file, "# Changelog\n\n- v1.0.0 shipped");
    await backfillAction("src_x", { markdownFile: file, commit: true });
    expect((postBody as { markdown?: string }).markdown).toContain("v1.0.0 shipped");
  });
});

// ── Async dispatch (202) wire contract ───────────────────────────────────────

const ASYNC_DISPATCH = {
  instanceId: "backfill-src_x-123",
  async: true,
  statusUrl: "https://test.example.com/v1/workflows/backfill-source/status/backfill-src_x-123",
};

describe("backfillSource async dispatch + status", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-backfill-async-"));
    process.env.RELEASES_RUN_DIR = dir;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the 202 async shape and isBackfillAsync discriminates it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(ASYNC_DISPATCH), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const res = await client.backfillSource({ sourceId: "src_x", dryRun: true });
    expect(client.isBackfillAsync(res)).toBe(true);
    expect(client.isBackfillAsync(SAMPLE_REPORT as never)).toBe(false);
    if (client.isBackfillAsync(res)) expect(res.instanceId).toBe("backfill-src_x-123");
  });

  it("getBackfillStatus GETs the status endpoint and returns the report output", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ instanceId: "i1", status: "complete", output: SAMPLE_REPORT }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;
    const status = await client.getBackfillStatus("i1");
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/backfill-source/status/i1");
    expect(status?.status).toBe("complete");
    expect(status?.output?.extracted).toBe(119);
  });

  it("getBackfillStatus returns null on a 404 (transient create→status race)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "instance_not_found", message: "nope" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    expect(await client.getBackfillStatus("missing")).toBeNull();
  });
});

// ── Async command behavior (dispatch-by-default + --wait) ────────────────────

describe("backfillAction async path", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;
  let statusCalls: number;

  // Resolve src → 202 dispatch on POST → a completed status on the first GET so
  // the poll loop breaks before the (5s) sleep ever fires.
  function mockAsync() {
    statusCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/workflows/backfill-source")) {
        return new Response(JSON.stringify(ASYNC_DISPATCH), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/workflows/backfill-source/status/")) {
        statusCalls += 1;
        return new Response(
          JSON.stringify({
            instanceId: "backfill-src_x-123",
            status: "complete",
            output: SAMPLE_REPORT,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
    dir = mkdtempSync(join(tmpdir(), "rel-backfill-async-cmd-"));
    process.env.RELEASES_RUN_DIR = dir;
    mockAsync();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches without polling by default (returns the handle)", async () => {
    await backfillAction("src_x", {});
    expect(statusCalls).toBe(0);
  });

  it("--json default dispatch emits the async handle on stdout", async () => {
    let out = "";
    const spy = ((s: string) => {
      out += s;
      return true;
    }) as unknown as typeof process.stdout.write;
    const orig = process.stdout.write;
    process.stdout.write = spy;
    try {
      await backfillAction("src_x", { json: true });
    } finally {
      process.stdout.write = orig;
    }
    expect(statusCalls).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ instanceId: "backfill-src_x-123", async: true });
  });

  it("--wait polls the status endpoint to completion and renders the report", async () => {
    await backfillAction("src_x", { wait: true });
    expect(statusCalls).toBe(1);
  });
});

// ── backfill-status (resume a dispatched workflow) ───────────────────────────

describe("backfillStatusAction", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "rel-backfill-status-"));
    process.env.RELEASES_RUN_DIR = dir;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RELEASES_RUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("GETs the status endpoint for the instance ID and renders a completed report", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ instanceId: "i9", status: "complete", output: SAMPLE_REPORT }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    await backfillStatusAction("i9", {});
    expect(capturedUrl).toBe("https://test.example.com/v1/workflows/backfill-source/status/i9");
  });

  it("--json emits the raw status (incl. output) for an in-progress workflow", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ instanceId: "i9", status: "running" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    let out = "";
    const spy = ((s: string) => {
      out += s;
      return true;
    }) as unknown as typeof process.stdout.write;
    const orig = process.stdout.write;
    process.stdout.write = spy;
    try {
      await backfillStatusAction("i9", { json: true });
    } finally {
      process.stdout.write = orig;
    }
    expect(JSON.parse(out)).toMatchObject({ status: "running" });
  });
});
