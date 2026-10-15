/**
 * Post-insert marketing classification for `POST /releases/batch`.
 *
 * The poll path classifies before insert. A bulk insert used to skip that
 * pass entirely. These tests lock the post-insert pass: off unless
 * `marketingFilter` is set, every inserted row is classified (including a
 * wave larger than 20), and a marketing verdict suppresses the row.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../tests/global-fetch";
import { classifyInsertedReleases } from "../src/lib/ingest/classify-inserted.js";
import type { ClassifyInsertedEnv } from "../src/lib/ingest/classify-inserted.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  return db;
}

async function seed(db: ReturnType<typeof mkDb>, metadata?: Record<string, unknown>) {
  await db.insert(organizations).values({
    id: "org_or",
    slug: "openrouter",
    name: "OpenRouter",
    category: "developer-tools",
  });
  await db.insert(sources).values({
    id: "src_blog",
    orgId: "org_or",
    slug: "openrouter-blog",
    name: "OpenRouter Blog",
    type: "feed",
    url: "https://openrouter.ai/blog",
    ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
  });
  const [source] = await db.select().from(sources).where(eq(sources.id, "src_blog"));
  return source as Source;
}

function modelEnv(): ClassifyInsertedEnv {
  return {
    OPENROUTER_ENABLED: "false",
    ANTHROPIC_API_KEY: { get: async () => "test-key" },
  };
}

function anthropicMarketing(marketing: boolean): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [
        {
          type: "text",
          text: `<marketing>${marketing}</marketing><reason>case_study</reason>`,
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 50,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("classifyInsertedReleases", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  it("does not call the model when marketingFilter is off", async () => {
    const db = mkDb();
    const source = await seed(db);
    await db.insert(releases).values({
      id: "rel_1",
      sourceId: "src_blog",
      title: "A product launch",
      content: "We shipped a new model.",
      url: "https://openrouter.ai/blog/launch",
    });
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch);

    const suppressed = await classifyInsertedReleases(db, modelEnv(), source, ["rel_1"]);

    expect(suppressed.size).toBe(0);
    expect(calls).toEqual([]);
    const [row] = await db.select().from(releases).where(eq(releases.id, "rel_1"));
    expect(row?.suppressed).toBe(false);
  });

  it("suppresses a marketing verdict and keeps a product post", async () => {
    const db = mkDb();
    const source = await seed(db, { marketingFilter: true });
    await db.insert(releases).values([
      {
        id: "rel_mkt",
        sourceId: "src_blog",
        title: "How Acme migrated",
        content: "A customer story.",
        url: "https://openrouter.ai/blog/acme",
      },
      {
        id: "rel_news",
        sourceId: "src_blog",
        title: "New model",
        content: "We added a model.",
        url: "https://openrouter.ai/blog/model",
      },
    ]);
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      const body = typeof init?.body === "string" ? init.body : "";
      const marketing = body.includes("How Acme migrated");
      return anthropicMarketing(marketing);
    }) as typeof fetch);

    const suppressed = await classifyInsertedReleases(db, modelEnv(), source, [
      "rel_mkt",
      "rel_news",
    ]);

    expect(calls.filter((url) => url.includes("api.anthropic.com"))).toHaveLength(2);
    expect([...suppressed]).toEqual(["rel_mkt"]);
    const [mkt] = await db.select().from(releases).where(eq(releases.id, "rel_mkt"));
    const [news] = await db.select().from(releases).where(eq(releases.id, "rel_news"));
    expect(mkt?.suppressed).toBe(true);
    expect(mkt?.suppressedReason).toBe("marketing_classifier:case_study");
    expect(news?.suppressed).toBe(false);
  });

  it("classifies every row when the insert is larger than 20", async () => {
    const db = mkDb();
    const source = await seed(db, { marketingFilter: true });
    const ids = Array.from({ length: 21 }, (_, i) => `rel_${i}`);
    await db.insert(releases).values(
      ids.map((id) => ({
        id,
        sourceId: "src_blog",
        title: `Post ${id}`,
        content: "A case study.",
        url: `https://openrouter.ai/blog/${id}`,
      })),
    );
    let calls = 0;
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      if (String(input).includes("api.anthropic.com")) calls++;
      return anthropicMarketing(true);
    }) as typeof fetch);

    const suppressed = await classifyInsertedReleases(db, modelEnv(), source, ids);

    expect(calls).toBe(21);
    expect(suppressed.size).toBe(21);
    const rows = await db.select().from(releases);
    expect(rows.every((row) => row.suppressed === true)).toBe(true);
  });
});
