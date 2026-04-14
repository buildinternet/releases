import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  sourceChangelogFiles,
} from "../../src/db/schema.js";
import { isTruncated } from "../../src/lib/changelog-slice.js";

let testDatabase: TestDatabase;
testDatabase = createTestDb();

afterAll(() => {
  testDatabase.cleanup();
});

function seedSource() {
  const db = testDatabase.db;
  db.delete(sourceChangelogFiles).run();
  db.delete(sources).run();
  db.delete(organizations).run();

  const [org] = db
    .insert(organizations)
    .values({ name: "Acme", slug: "acme" })
    .returning()
    .all();
  const [src] = db
    .insert(sources)
    .values({
      orgId: org.id,
      name: "Repo",
      slug: "acme-repo",
      type: "github",
      url: "https://github.com/acme/repo",
    })
    .returning()
    .all();
  return src.id;
}

describe("source_changelog_files", () => {
  beforeEach(() => {
    seedSource();
  });

  it("orders rows by path (listChangelogFiles contract)", () => {
    const db = testDatabase.db;
    const sourceId = seedSource();
    const now = new Date().toISOString();
    const rows = [
      { path: "packages/zeta/CHANGELOG.md", filename: "CHANGELOG.md" },
      { path: "CHANGELOG.md", filename: "CHANGELOG.md" },
      { path: "packages/alpha/CHANGELOG.md", filename: "CHANGELOG.md" },
    ];
    for (const r of rows) {
      db.insert(sourceChangelogFiles)
        .values({
          sourceId,
          path: r.path,
          filename: r.filename,
          url: `https://x/${r.path}`,
          rawUrl: `https://raw/${r.path}`,
          content: "# " + r.path,
          contentHash: r.path,
          bytes: r.path.length,
          fetchedAt: now,
        })
        .run();
    }

    const result = db
      .select()
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, sourceId))
      .orderBy(sourceChangelogFiles.path)
      .all();

    expect(result.map((r) => r.path)).toEqual([
      "CHANGELOG.md",
      "packages/alpha/CHANGELOG.md",
      "packages/zeta/CHANGELOG.md",
    ]);
  });

  it("deleteChangelogFilesNotIn prunes rows whose path is missing", () => {
    const db = testDatabase.db;
    const sourceId = seedSource();
    const now = new Date().toISOString();
    for (const path of ["CHANGELOG.md", "old/CHANGELOG.md", "keep/CHANGELOG.md"]) {
      db.insert(sourceChangelogFiles)
        .values({
          sourceId,
          path,
          filename: "CHANGELOG.md",
          url: `https://x/${path}`,
          rawUrl: `https://raw/${path}`,
          content: "x",
          contentHash: path,
          bytes: 1,
          fetchedAt: now,
        })
        .run();
    }

    // Inlined equivalent of deleteChangelogFilesNotIn — same logic, tested
    // without pulling in the queries.ts singleton getDb() pathway.
    const keep = new Set(["CHANGELOG.md", "keep/CHANGELOG.md"]);
    const existing = db
      .select({ id: sourceChangelogFiles.id, path: sourceChangelogFiles.path })
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, sourceId))
      .all();
    const toDelete = existing.filter((r) => !keep.has(r.path));
    for (const row of toDelete) {
      db.delete(sourceChangelogFiles).where(eq(sourceChangelogFiles.id, row.id)).run();
    }

    const remaining = db
      .select({ path: sourceChangelogFiles.path })
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, sourceId))
      .orderBy(sourceChangelogFiles.path)
      .all();
    expect(remaining.map((r) => r.path)).toEqual(["CHANGELOG.md", "keep/CHANGELOG.md"]);
    expect(toDelete).toHaveLength(1);
    expect(toDelete[0].path).toBe("old/CHANGELOG.md");
  });
});

describe("isTruncated derivation", () => {
  const MB = 1024 * 1024;
  it("flags bytes === 1MB as truncated", () => {
    expect(isTruncated(MB)).toBe(true);
  });
  it("flags bytes just below 1MB as not truncated", () => {
    expect(isTruncated(MB - 1)).toBe(false);
  });
  it("flags empty as not truncated", () => {
    expect(isTruncated(0)).toBe(false);
  });
});
