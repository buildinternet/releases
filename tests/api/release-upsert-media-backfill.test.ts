import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq } from "drizzle-orm";
import * as schema from "@buildinternet/releases-core/schema";
import { releases } from "@buildinternet/releases-core/schema";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { applyMigrations } from "../db-helper";

// Behavioral coverage for RELEASE_URL_UPSERT's media backfill (Lever C). A
// crawl source whose large body tripped the extraction guardrail stored its
// releases with empty media; once the guardrail stops dropping media, a normal
// re-fetch must heal those rows. The upsert is the only re-fetch path that can,
// so it must: (1) fill empty/`'[]'` media from the incoming row, (2) never
// clobber already-populated media, (3) leave the existing content-stub backfill
// untouched. No `foreign_keys=ON` pragma here so a release can stand alone.

const SOURCE = "src_upsert_media_test";
const ENTRY_URL = "https://example.invalid/changes/entry-1";
const NEW_MEDIA = JSON.stringify([{ type: "image", url: "https://cdn.example/hero.png" }]);

let db: ReturnType<typeof drizzle<typeof schema>>;

function row(over: Record<string, unknown> = {}) {
  return {
    sourceId: SOURCE,
    type: "feature" as const,
    title: "Entry 1",
    content: "Real body content.",
    url: ENTRY_URL,
    contentHash: "h1",
    contentChars: 18,
    contentTokens: 5,
    publishedAt: "2026-06-01",
    media: "[]",
    ...over,
  };
}

function readBack() {
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.sourceId, SOURCE), eq(releases.url, ENTRY_URL)))
    .get();
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  sqlite.run("PRAGMA foreign_keys=OFF"); // releases stand alone here — no org/source seeding
  db = drizzle(sqlite, { schema });
});

describe("RELEASE_URL_UPSERT media backfill", () => {
  it("fills empty media from a re-fetch without overwriting existing content", () => {
    db.insert(releases)
      .values(row({ media: "[]" }))
      .run();
    // Re-fetch: same (source_id, url), now carrying media + a different body.
    db.insert(releases)
      .values(row({ content: "DIFFERENT BODY", contentHash: "h2", media: NEW_MEDIA }))
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .run();

    const r = readBack();
    expect(r?.media).toBe(NEW_MEDIA); // media backfilled
    expect(r?.content).toBe("Real body content."); // content already present → untouched
  });

  it("treats NULL media as empty and backfills it", () => {
    db.insert(releases)
      .values(row({ media: null }))
      .run();
    db.insert(releases)
      .values(row({ media: NEW_MEDIA }))
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .run();
    expect(readBack()?.media).toBe(NEW_MEDIA);
  });

  it("never overwrites media that is already populated", () => {
    const existing = JSON.stringify([{ type: "image", url: "https://cdn.example/original.png" }]);
    db.insert(releases)
      .values(row({ media: existing }))
      .run();
    db.insert(releases)
      .values(row({ media: NEW_MEDIA }))
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .run();
    expect(readBack()?.media).toBe(existing); // unchanged
  });

  it("does not write empty incoming media over an empty stored row (no-op)", () => {
    db.insert(releases)
      .values(row({ media: "[]" }))
      .run();
    db.insert(releases)
      .values(row({ content: "X", media: "[]" }))
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .run();
    expect(readBack()?.media).toBe("[]");
  });

  it("still backfills content for an empty stub (existing behavior intact)", () => {
    db.insert(releases)
      .values(row({ content: "", contentHash: "", media: "[]" }))
      .run();
    db.insert(releases)
      .values(row({ content: "Filled in.", contentHash: "h3", media: "[]" }))
      .onConflictDoUpdate(RELEASE_URL_UPSERT)
      .run();
    expect(readBack()?.content).toBe("Filled in.");
  });
});
