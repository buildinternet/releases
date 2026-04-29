import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildChangelogResponse,
  selectChangelogFile,
} from "@buildinternet/releases-core/changelog-slice";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { eq } from "drizzle-orm";
import {
  organizations,
  sources,
  sourceChangelogFiles,
  type SourceChangelogFile,
} from "@buildinternet/releases-core/schema";

// This test exercises the response-building path used by both
// `handleSourceChangelog` (src/api/routes/sources.ts) and
// `GET /v1/sources/:slug/changelog` (workers/api/src/routes/sources.ts).
// It uses the canonical `selectChangelogFile` from the core package to pick
// the row, then asserts on the `buildChangelogResponse` output — the part
// that's unique to the worker layer. The not-found sentinels are covered
// by the core package's own tests.

const MB = 1024 * 1024;

let tdb: TestDatabase;
let sourceId: string;

beforeAll(() => {
  tdb = createTestDb();
  const db = tdb.db;
  const [org] = db.insert(organizations).values({ name: "Acme", slug: "acme" }).returning().all();
  const [src] = db
    .insert(sources)
    .values({
      orgId: org.id,
      name: "Repo",
      slug: "acme-monorepo",
      type: "github",
      url: "https://github.com/acme/monorepo",
    })
    .returning()
    .all();
  sourceId = src.id;

  const now = new Date().toISOString();
  const rows = [
    { path: "CHANGELOG.md", content: "# Root\n\nhello", bytes: 13 },
    { path: "packages/alpha/CHANGELOG.md", content: "# alpha\n", bytes: 8 },
    { path: "packages/huge/CHANGELOG.md", content: "x".repeat(MB), bytes: MB },
  ];
  for (const r of rows) {
    db.insert(sourceChangelogFiles)
      .values({
        sourceId: src.id,
        path: r.path,
        filename: r.path.split("/").pop()!,
        url: `https://github.com/acme/monorepo/blob/HEAD/${r.path}`,
        rawUrl: `https://raw.githubusercontent.com/acme/monorepo/HEAD/${r.path}`,
        content: r.content,
        contentHash: r.path,
        bytes: r.bytes,
        fetchedAt: now,
      })
      .run();
  }
});

afterAll(() => {
  tdb?.cleanup();
});

function fetchAll(): SourceChangelogFile[] {
  return tdb.db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, sourceId))
    .orderBy(sourceChangelogFiles.path)
    .all();
}

function buildFiles(rows: SourceChangelogFile[]) {
  return rows.map((r) => ({
    path: r.path,
    filename: r.filename,
    url: r.url,
    bytes: r.bytes,
    fetchedAt: r.fetchedAt,
  }));
}

function selectOrFail(rows: SourceChangelogFile[], path: string | null): SourceChangelogFile {
  const selected = selectChangelogFile(rows, path);
  if (!selected) throw new Error("expected row");
  return selected;
}

describe("source changelog route resolution", () => {
  it("returns the root file when path is omitted", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, null);
    const res = buildChangelogResponse(selected, { offset: null, limit: null }, buildFiles(rows));
    expect(res.path).toBe("CHANGELOG.md");
    expect(res.truncated).toBe(false);
  });

  it("includes a files index for every tracked file", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, null);
    const res = buildChangelogResponse(selected, { offset: null, limit: null }, buildFiles(rows));
    expect(res.files.map((f) => f.path).toSorted()).toEqual([
      "CHANGELOG.md",
      "packages/alpha/CHANGELOG.md",
      "packages/huge/CHANGELOG.md",
    ]);
    for (const f of res.files) {
      expect("content" in f).toBe(false);
    }
  });

  it("resolves path=<known> to the requested file", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, "packages/alpha/CHANGELOG.md");
    const res = buildChangelogResponse(selected, { offset: null, limit: null }, buildFiles(rows));
    expect(res.path).toBe("packages/alpha/CHANGELOG.md");
    expect(res.content).toBe("# alpha\n");
  });

  it("flags truncated=true when bytes === 1MB", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, "packages/huge/CHANGELOG.md");
    const res = buildChangelogResponse(selected, { offset: null, limit: null }, buildFiles(rows));
    expect(res.truncated).toBe(true);
    expect(res.truncatedAt).toBe(MB);
  });

  it("falls back to live encoding when row.tokens is null", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, "CHANGELOG.md");
    const res = buildChangelogResponse(
      { ...selected, tokens: null },
      { offset: null, limit: null },
      buildFiles(rows),
    );
    // A 13-char file encodes to a small but non-zero number of tokens.
    expect(res.totalTokens).toBeGreaterThan(0);
    expect(res.totalTokens).toBeLessThan(20);
  });

  it("honors the tokens range param end-to-end through buildChangelogResponse", () => {
    const rows = fetchAll();
    const selected = selectOrFail(rows, "CHANGELOG.md");
    const res = buildChangelogResponse(
      selected,
      { offset: null, limit: null, tokens: "100" },
      buildFiles(rows),
    );
    expect(res.tokens).toBe(100);
    expect(res.sliceTokens).toBeDefined();
    expect(res.sliceTokens!).toBeLessThanOrEqual(100);
  });

  it("uses countTokensSafe fallback for oversized rows without cached tokens", () => {
    // If the 256KB cap in countTokensSafe weren't applied, encoding 1MB
    // of repeated chars would hang js-tiktoken for minutes. The cap
    // forces a chars/4 fallback, which equals length/4 for this fixture.
    const rows = fetchAll();
    const huge = rows.find((r) => r.path === "packages/huge/CHANGELOG.md");
    if (!huge) throw new Error("expected huge fixture");
    const res = buildChangelogResponse(
      { ...huge, tokens: null },
      { offset: null, limit: null },
      buildFiles(rows),
    );
    expect(res.totalTokens).toBe(Math.ceil(huge.content.length / 4));
    expect(res.truncated).toBe(true);
  });
});
