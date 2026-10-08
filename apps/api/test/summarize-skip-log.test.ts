/**
 * Pre-model summarization skips emit `summarize-skip` (lane + reason + count)
 * without changing which releases reach the model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../tests/global-fetch";
import { generateContentForReleases } from "../src/lib/ingest/ingest-steps.js";
import { logSummarizeSkip } from "../src/lib/ai/summarize-skip.js";

const REAL_BODY = "Fixed the installer bug that dropped the CLI binary on macOS.";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  return db;
}

async function seed(
  db: ReturnType<typeof mkDb>,
  opts: { autoGen?: boolean; summarize?: boolean; hidden?: boolean } = {},
) {
  await db.insert(organizations).values({
    id: "org_s",
    slug: "supabase",
    name: "Supabase",
    category: "developer-tools",
    autoGenerateContent: opts.autoGen ?? true,
  });
  await db.insert(sources).values({
    id: "src_s",
    orgId: "org_s",
    slug: "supabase-cli",
    name: "Supabase CLI",
    type: "github",
    url: "https://github.com/supabase/cli",
    isHidden: opts.hidden ?? false,
    ...(opts.summarize === false ? { metadata: JSON.stringify({ summarize: false }) } : {}),
  });
  const [source] = await db.select().from(sources).where(eq(sources.id, "src_s"));
  return source;
}

async function insertRelease(
  db: ReturnType<typeof mkDb>,
  id: string,
  content: string,
  sourceId = "src_s",
) {
  await db
    .insert(releases)
    .values({ id, sourceId, title: id, content, url: `https://example.com/${id}` });
}

function modelEnv() {
  return {
    OPENROUTER_ENABLED: "false",
    ANTHROPIC_API_KEY: { get: async () => "test-key" },
  };
}

function parseEvents(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed.event === "string") out.push(parsed);
    } catch {
      // non-JSON console noise
    }
  }
  return out;
}

function skips(events: Record<string, unknown>[]) {
  return events.filter((e) => e.event === "summarize-skip");
}

describe("summarize-skip logging", () => {
  const lines: string[] = [];
  let restoreConsole: () => void;

  beforeEach(() => {
    lines.length = 0;
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const push = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.log = push as typeof console.log;
    console.warn = push as typeof console.warn;
    console.error = push as typeof console.error;
    restoreConsole = () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    };
  });

  afterEach(() => {
    restoreConsole();
    restoreGlobalFetch();
  });

  it("emits reason=empty for an empty body and still writes batch-summary", async () => {
    const db = mkDb();
    const source = await seed(db);
    await insertRelease(db, "rel_empty_1", "");
    await insertRelease(db, "rel_empty_2", "   ");
    await insertRelease(db, "rel_empty_3", "chore");
    await insertRelease(db, "rel_empty_4", "Updated dependencies");
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, [
      "rel_empty_1",
      "rel_empty_2",
      "rel_empty_3",
      "rel_empty_4",
    ]);

    expect(generated).toBe(0);
    expect(calls).toEqual([]);
    const events = parseEvents(lines);
    const empty = skips(events);
    expect(empty).toEqual([
      expect.objectContaining({
        component: "auto-generate-content",
        event: "summarize-skip",
        lane: "summarize-release",
        reason: "empty",
        sourceSlug: "supabase-cli",
        count: 4,
        releaseIds: ["rel_empty_1", "rel_empty_2", "rel_empty_3", "rel_empty_4"],
        releaseIdsTruncated: false,
      }),
    ]);
    const summary = events.find((e) => e.event === "batch-summary");
    expect(summary).toMatchObject({
      candidateCount: 4,
      generated: 0,
      skippedEmpty: 4,
      skippedTooLarge: 0,
    });
    const stored = await db.select().from(releases);
    expect(stored.every((row) => row.titleGenerated === null)).toBe(true);
  });

  it("emits reason=too-large and keeps the per-row body-cap-skip detail", async () => {
    const db = mkDb();
    const source = await seed(db);
    await insertRelease(db, "rel_big", "x".repeat(50_001));
    mockGlobalFetch(
      (async (_input: RequestInfo | URL) =>
        new Response("unexpected", { status: 500 })) as typeof fetch,
    );

    await generateContentForReleases(db, modelEnv(), source, ["rel_big"]);

    const events = parseEvents(lines);
    expect(skips(events)).toEqual([
      expect.objectContaining({
        reason: "too-large",
        lane: "summarize-release",
        count: 1,
        releaseIds: ["rel_big"],
      }),
    ]);
    expect(events.find((e) => e.event === "body-cap-skip")).toMatchObject({
      releaseId: "rel_big",
      cap: 50_000,
    });
    expect(events.find((e) => e.event === "batch-summary")).toMatchObject({
      candidateCount: 1,
      skippedTooLarge: 1,
      skippedEmpty: 0,
      generated: 0,
    });
  });

  it("summarizes an eligible body and does not skip it", async () => {
    const db = mkDb();
    const source = await seed(db);
    await insertRelease(db, "rel_empty", "");
    await insertRelease(db, "rel_real", REAL_BODY);
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("api.anthropic.com")) {
        return new Response(`unexpected ${url}`, { status: 500 });
      }
      const text =
        "<title>Supabase CLI fixes the installer</title><title_short>Installer keeps the CLI binary</title_short><summary>The macOS installer no longer drops the CLI binary.</summary>";
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, [
      "rel_empty",
      "rel_real",
    ]);

    expect(generated).toBe(1);
    expect(calls.some((url) => url.includes("api.anthropic.com"))).toBe(true);
    const events = parseEvents(lines);
    expect(skips(events).map((e) => e.reason)).toEqual(["empty"]);
    expect(skips(events)[0]?.releaseIds).toEqual(["rel_empty"]);
    const [real] = await db.select().from(releases).where(eq(releases.id, "rel_real"));
    const [empty] = await db.select().from(releases).where(eq(releases.id, "rel_empty"));
    expect(real?.titleGenerated).toBe("Supabase CLI fixes the installer");
    expect(empty?.titleGenerated).toBeNull();
    expect(events.find((e) => e.event === "batch-summary")).toMatchObject({
      candidateCount: 2,
      generated: 1,
      skippedEmpty: 1,
      skippedTooLarge: 0,
    });
  });

  it("emits reason=opted-out when autoGenerateContent is false and does not call the model", async () => {
    const db = mkDb();
    const source = await seed(db, { autoGen: false });
    await insertRelease(db, "rel_a", REAL_BODY);
    await insertRelease(db, "rel_b", "");
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, ["rel_a", "rel_b"]);

    expect(generated).toBe(0);
    expect(calls).toEqual([]);
    const events = parseEvents(lines);
    expect(skips(events)).toEqual([
      expect.objectContaining({
        reason: "opted-out",
        count: 2,
        releaseIds: ["rel_a", "rel_b"],
        sourceSlug: "supabase-cli",
      }),
    ]);
    expect(events.find((e) => e.event === "batch-summary")).toBeUndefined();
  });

  it("still summarizes an opted-out org when the caller ignores that gate", async () => {
    const db = mkDb();
    const source = await seed(db, { autoGen: false });
    await insertRelease(db, "rel_real", REAL_BODY);
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      if (!String(input).includes("api.anthropic.com")) {
        return new Response("unexpected", { status: 500 });
      }
      const text =
        "<title>Supabase CLI fixes the installer</title><title_short>Installer keeps the CLI binary</title_short><summary>The macOS installer no longer drops the CLI binary.</summary>";
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, ["rel_real"], {
      ignoreAutoGenerateGate: true,
    });

    expect(generated).toBe(1);
    expect(skips(parseEvents(lines))).toEqual([]);
    const [row] = await db.select().from(releases).where(eq(releases.id, "rel_real"));
    expect(row?.titleGenerated).toBe("Supabase CLI fixes the installer");
  });

  it("emits reason=hidden for a hidden source", async () => {
    const db = mkDb();
    const source = await seed(db, { hidden: true });
    await insertRelease(db, "rel_a", REAL_BODY);
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch);

    const generated = await generateContentForReleases(
      db,
      modelEnv(),
      {
        ...source,
        isHidden: true,
      } as Source,
      ["rel_a"],
    );

    expect(generated).toBe(0);
    expect(calls).toEqual([]);
    expect(skips(parseEvents(lines))).toEqual([
      expect.objectContaining({ reason: "hidden", count: 1, releaseIds: ["rel_a"] }),
    ]);
  });

  it("emits reason=source-opt-out when metadata.summarize is false", async () => {
    const db = mkDb();
    const source = await seed(db, { summarize: false });
    await insertRelease(db, "rel_a", REAL_BODY);

    await generateContentForReleases(db, {} as never, source, ["rel_a"]);

    expect(skips(parseEvents(lines))).toEqual([
      expect.objectContaining({ reason: "source-opt-out", count: 1, releaseIds: ["rel_a"] }),
    ]);
  });

  it("emits reason=coverage for a coverage-side row and still summarizes the canonical", async () => {
    const db = mkDb();
    const source = await seed(db);
    await insertRelease(db, "rel_canon", REAL_BODY);
    await insertRelease(db, "rel_cov", REAL_BODY);
    await db.insert(releaseCoverage).values({
      coverageId: "rel_cov",
      canonicalId: "rel_canon",
      decidedBy: "human:test",
    });
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (!String(input).includes("api.anthropic.com")) {
        return new Response("unexpected", { status: 500 });
      }
      const text =
        "<title>Supabase CLI fixes the installer</title><title_short>Installer keeps the CLI binary</title_short><summary>The macOS installer no longer drops the CLI binary.</summary>";
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, [
      "rel_canon",
      "rel_cov",
    ]);

    expect(generated).toBe(1);
    expect(calls.filter((url) => url.includes("api.anthropic.com"))).toHaveLength(1);
    expect(skips(parseEvents(lines))).toEqual([
      expect.objectContaining({ reason: "coverage", count: 1, releaseIds: ["rel_cov"] }),
    ]);
    const [canon] = await db.select().from(releases).where(eq(releases.id, "rel_canon"));
    const [cov] = await db.select().from(releases).where(eq(releases.id, "rel_cov"));
    expect(canon?.titleGenerated).toBe("Supabase CLI fixes the installer");
    expect(cov?.titleGenerated).toBeNull();
  });

  it("prefers opted-out over coverage when the org gate already excludes the row", async () => {
    const db = mkDb();
    const source = await seed(db, { autoGen: false });
    await insertRelease(db, "rel_canon", REAL_BODY);
    await insertRelease(db, "rel_cov", REAL_BODY);
    await db.insert(releaseCoverage).values({
      coverageId: "rel_cov",
      canonicalId: "rel_canon",
      decidedBy: "human:test",
    });

    await generateContentForReleases(db, {} as never, source, ["rel_canon", "rel_cov"]);

    const events = skips(parseEvents(lines));
    expect(events.map((e) => e.reason)).toEqual(["opted-out"]);
    expect(events[0]?.count).toBe(2);
  });

  it("emits reason=missing for an inserted id that is not in the database", async () => {
    const db = mkDb();
    const source = await seed(db);

    await generateContentForReleases(db, {} as never, source, ["rel_gone"]);

    expect(skips(parseEvents(lines))).toEqual([
      expect.objectContaining({ reason: "missing", count: 1, releaseIds: ["rel_gone"] }),
    ]);
  });

  it("emits reason=row-cap for the whole candidate set and does not call the model", async () => {
    const db = mkDb();
    const source = await seed(db);
    const ids = Array.from({ length: 21 }, (_, i) => `rel_${i}`);
    await db.insert(releases).values(
      ids.map((id) => ({
        id,
        sourceId: "src_s",
        title: id,
        content: REAL_BODY,
        url: `https://example.com/${id}`,
      })),
    );
    const calls: string[] = [];
    mockGlobalFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch);

    const generated = await generateContentForReleases(db, modelEnv(), source, ids);

    expect(generated).toBe(0);
    expect(calls).toEqual([]);
    const events = parseEvents(lines);
    expect(events.find((e) => e.event === "row-cap-tripped")).toMatchObject({
      candidateCount: 21,
      cap: 20,
    });
    expect(skips(events)).toEqual([
      expect.objectContaining({
        reason: "row-cap",
        count: 21,
        releaseIdsTruncated: true,
      }),
    ]);
    expect(skips(events)[0]?.releaseIds).toHaveLength(20);
    expect(events.find((e) => e.event === "batch-summary")).toBeUndefined();
  });

  it("truncates releaseIds but keeps count exact", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rel_${i}`);
    logSummarizeSkip({
      component: "auto-generate-content",
      reason: "empty",
      releaseIds: ids,
      sourceSlug: "supabase-cli",
    });
    const [event] = skips(parseEvents(lines));
    expect(event).toMatchObject({ count: 25, releaseIdsTruncated: true });
    expect(event?.releaseIds).toHaveLength(20);
  });
});
