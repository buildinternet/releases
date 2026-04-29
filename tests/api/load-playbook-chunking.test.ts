import { describe, it, expect } from "bun:test";
import { applyMigrations } from "../db-helper";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, knowledgePages } from "@buildinternet/releases-core/schema";
import { loadPlaybookNotesForSources } from "../../workers/api/src/cron/poll-fetch.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "../../workers/api/src/lib/d1-limits.js";

// Regression: the helper used to pass every distinct orgId in one IN clause,
// so a working set with > D1_MAX_BINDINGS distinct orgs would 500 against D1.
// The chunked loop must collect rows from every chunk, including ones that
// straddle the chunk boundary at RELEASES_ID_IN_CHUNK_SIZE.

function makeDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

describe("loadPlaybookNotesForSources chunking", () => {
  it("returns notes for every matched org across multiple chunks", async () => {
    const db = makeDb();
    const total = RELEASES_ID_IN_CHUNK_SIZE * 2 + 5; // 185, forces 3 chunks
    const orgIds = Array.from({ length: total }, (_, i) => `org_${i.toString().padStart(4, "0")}`);

    for (const id of orgIds) {
      db.insert(organizations).values({ id, name: id, slug: id }).run();
    }

    // Add a playbook for every odd-indexed org so the assertion exercises both
    // matching and missing rows across chunk boundaries.
    const expectedNotes = new Map<string, string>();
    for (let i = 0; i < orgIds.length; i++) {
      if (i % 2 === 1) {
        const notes = `notes-${i}`;
        expectedNotes.set(orgIds[i]!, notes);
        db.insert(knowledgePages)
          .values({ scope: "playbook", orgId: orgIds[i], content: "", notes } as any)
          .run();
      }
    }

    const sourceLike = orgIds.map((orgId) => ({ orgId }));
    const result = await loadPlaybookNotesForSources(db as any, sourceLike);

    expect(result.size).toBe(expectedNotes.size);
    for (const [orgId, notes] of expectedNotes) {
      expect(result.get(orgId)).toBe(notes);
    }
    // Spot-check an org from the third chunk (index > 2 * chunk size) to
    // confirm rows past the boundary aren't silently dropped.
    const lastWithPlaybook = orgIds[total - 1 - ((total - 1) % 2 === 0 ? 1 : 0)]!;
    expect(result.has(lastWithPlaybook)).toBe(true);
  });

  it("returns an empty map for an empty input", async () => {
    const db = makeDb();
    const result = await loadPlaybookNotesForSources(db as any, []);
    expect(result.size).toBe(0);
  });

  it("ignores rows with null orgId", async () => {
    const db = makeDb();
    const result = await loadPlaybookNotesForSources(db as any, [{ orgId: null }, { orgId: null }]);
    expect(result.size).toBe(0);
  });
});
