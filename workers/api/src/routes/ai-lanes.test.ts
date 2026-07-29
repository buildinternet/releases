/**
 * POST /v1/ai/lanes/:lane — in-process route smoke tests, following the
 * `routes.request(path, init, env)` pattern used by ../../test/auth-middleware.test.ts
 * and the firecrawl route tests (createTestDb + a fake env).
 *
 * The lane call goes through the real `resolveMarketingModel` /
 * `resolveSummarizeModel` / `resolveArticleExtractModel` → `buildLaneAnthropicModel`
 * → `@ai-sdk/anthropic`'s real `generateText` path (this is deliberate — it's
 * the exact seam production uses, and the whole point of the endpoint is to
 * prove that seam resolves correctly). What's faked is the wire transport: a
 * scoped `globalThis.fetch` override returns a canned Anthropic Messages API
 * response, restored after every test so it can't leak into sibling suites in
 * this same bun process (see AGENTS.md's bun mock.module leak note — this is
 * the same class of hazard, so it gets the same discipline: paired
 * override/restore, never left dangling).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { aiLaneRoutes } from "./ai-lanes.js";

let testDatabase: TestDatabase;
let fetchApi: (req: Request) => Response | Promise<Response>;

/** Fake Secrets Store binding — `getSecret` calls `.get()`. */
function secretBinding(value: string) {
  return { get: async () => value };
}

function baseEnv() {
  return {
    DB: testDatabase.db,
    ANTHROPIC_API_KEY: secretBinding("test-anthropic-key"),
    // Deliberately no FLAGS binding + no OPENROUTER_ENABLED var: `flag()` falls
    // through to its default (openrouter-enabled = off), so every lane
    // resolves the Anthropic Haiku fallback — the path exercised below.
  };
}

const originalFetch = globalThis.fetch;

interface AnthropicUsage {
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}

/** Install a fake `fetch` that answers any call as the Anthropic Messages API,
 *  returning `text` as the sole content block. Scoped per-test; always paired
 *  with `restoreFetch()` in `afterEach`. */
function mockAnthropicFetch(text: string, usage: AnthropicUsage = {}) {
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: usage.input ?? 10,
          output_tokens: usage.output ?? 5,
          cache_creation_input_tokens: usage.cacheCreate ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

beforeAll(() => {
  testDatabase = createTestDb();
  const app = new Hono();
  app.route("/v1", aiLaneRoutes);
  fetchApi = (req) => app.fetch(req, baseEnv() as never);
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(async () => {
  clearAllTables(testDatabase.db);
  await testDatabase.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await testDatabase.db.insert(sources).values({
    id: "src_1",
    orgId: "org_1",
    name: "Acme Blog",
    slug: "acme-blog",
    type: "scrape",
    url: "https://acme.example.com/blog",
  });
  await testDatabase.db.insert(releases).values({
    id: "rel_1",
    sourceId: "src_1",
    title: "Acme v2.0 released",
    content: "Acme v2.0 ships a faster query planner and fixes several bugs.",
    url: "https://acme.example.com/blog/v2",
  });
});

afterEach(() => {
  restoreFetch();
});

function post(path: string, body: unknown) {
  return fetchApi(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

type ErrorBody = { error: { code: string; type: string; message: string } };

describe("POST /v1/ai/lanes/:lane", () => {
  it("400s on an unknown lane", async () => {
    const res = await post("/v1/ai/lanes/nonsense", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("validation");
  });

  it("400s when apply:true is sent without releaseId", async () => {
    const res = await post("/v1/ai/lanes/marketing", {
      title: "Some title",
      content: "Some content",
      apply: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("validation");
    expect(body.error.message).toMatch(/apply: true requires releaseId/);
  });

  it("400s on the marketing lane with no title available", async () => {
    const res = await post("/v1/ai/lanes/marketing", { content: "just content, no title" });
    expect(res.status).toBe(400);
  });

  it("dry-run marketing classification returns provider+model and does NOT write suppressed", async () => {
    mockAnthropicFetch("<marketing>false</marketing>");

    const res = await post("/v1/ai/lanes/marketing", { releaseId: "rel_1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lane: string;
      provider: string;
      model: string;
      applied: boolean;
      result: { isMarketing: boolean; reason: string };
      usage: { input: number; output: number; cacheCreate: number; cacheRead: number };
    };
    expect(body.lane).toBe("marketing");
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.applied).toBe(false);
    expect(body.result.isMarketing).toBe(false);
    expect(body.usage.input).toBe(10);

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.suppressed).toBeFalsy();
  });

  it("apply:true on the marketing lane writes suppressed + suppressedReason", async () => {
    mockAnthropicFetch("<marketing>true</marketing>\n<reason>case_study</reason>");

    const res = await post("/v1/ai/lanes/marketing", { releaseId: "rel_1", apply: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; result: { isMarketing: boolean } };
    expect(body.applied).toBe(true);
    expect(body.result.isMarketing).toBe(true);

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.suppressed).toBe(true);
    expect(row?.suppressedReason).toBe("marketing_classifier:case_study");
  });

  it("inline title/content override the stored release (what-if probing) without requiring apply", async () => {
    mockAnthropicFetch("<marketing>false</marketing>");

    const res = await post("/v1/ai/lanes/marketing", {
      releaseId: "rel_1",
      title: "How Acme Corp cut costs 50% with themselves",
      content: "A customer success story.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input: { title: string; content: string } };
    expect(body.input.title).toBe("How Acme Corp cut costs 50% with themselves");
    expect(body.input.content).toBe("A customer success story.");
  });

  it("dry-run summarize does not write title/summary columns", async () => {
    mockAnthropicFetch(
      "<empty>false</empty>\n<title>Acme v2.0 speeds up queries</title>\n<title_short>Faster queries in v2.0</title_short>\n<summary>Acme v2.0 ships a faster query planner and fixes bugs.</summary>\n<composition><bugs>1</bugs><features>0</features><enhancements>1</enhancements></composition>\n<breaking>none</breaking>\n<migration>none</migration>\n<importance>3</importance>",
    );

    const res = await post("/v1/ai/lanes/summarize", { releaseId: "rel_1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: boolean;
      result: { title: string | null; summary: string | null; importance: number | null };
    };
    expect(body.applied).toBe(false);
    expect(body.result.title).toBe("Acme v2.0 speeds up queries");
    expect(body.result.importance).toBe(3);

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.titleGenerated).toBeNull();
    expect(row?.summary).toBeNull();
  });

  it("apply:true on the summarize lane writes title_generated/title_short/summary/importance", async () => {
    mockAnthropicFetch(
      "<empty>false</empty>\n<title>Acme v2.0 speeds up queries</title>\n<title_short>Faster queries in v2.0</title_short>\n<summary>Acme v2.0 ships a faster query planner and fixes bugs.</summary>\n<composition><bugs>1</bugs><features>0</features><enhancements>1</enhancements></composition>\n<breaking>none</breaking>\n<migration>none</migration>\n<importance>3</importance>",
    );

    const res = await post("/v1/ai/lanes/summarize", { releaseId: "rel_1", apply: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean };
    expect(body.applied).toBe(true);

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.titleGenerated).toBe("Acme v2.0 speeds up queries");
    expect(row?.titleShort).toBe("Faster queries in v2.0");
    expect(row?.summary).toBe("Acme v2.0 ships a faster query planner and fixes bugs.");
    expect(row?.importance).toBe(3);
  });

  it("400s on the summarize lane with no content available", async () => {
    const res = await post("/v1/ai/lanes/summarize", { title: "just a title" });
    expect(res.status).toBe(400);
  });

  it("dry-run feed-enrich does not write content", async () => {
    mockAnthropicFetch("<article>Cleaned up article body.</article>");

    const res = await post("/v1/ai/lanes/feed-enrich", { releaseId: "rel_1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; result: { content: string } };
    expect(body.applied).toBe(false);
    expect(body.result.content).toBe("Cleaned up article body.");

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.content).toBe("Acme v2.0 ships a faster query planner and fixes several bugs.");
  });

  it("apply:true on the feed-enrich lane overwrites content", async () => {
    mockAnthropicFetch("<article>Cleaned up article body.</article>");

    const res = await post("/v1/ai/lanes/feed-enrich", { releaseId: "rel_1", apply: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean };
    expect(body.applied).toBe(true);

    const row = await testDatabase.db.query.releases.findFirst({
      where: (r, { eq }) => eq(r.id, "rel_1"),
    });
    expect(row?.content).toBe("Cleaned up article body.");
  });

  it("400s on the feed-enrich lane with no content available", async () => {
    const res = await post("/v1/ai/lanes/feed-enrich", { title: "just a title" });
    expect(res.status).toBe(400);
  });

  it("404s when releaseId does not resolve", async () => {
    const res = await post("/v1/ai/lanes/marketing", { releaseId: "rel_does_not_exist" });
    expect(res.status).toBe(404);
  });

  it("404s when sourceId does not resolve", async () => {
    const res = await post("/v1/ai/lanes/marketing", {
      title: "t",
      content: "c",
      sourceId: "src_does_not_exist",
    });
    expect(res.status).toBe(404);
  });
});
