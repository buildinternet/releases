/**
 * runGenerateContent — the testable core behind POST /v1/workflows/generate-content.
 *
 * Verifies candidate selection (fill-missing vs. regenerate), the org eligibility
 * gate, dry-run safety, explicit releaseIds scoping, the limit cap, and that
 * regenerate NULLs existing generated content first (so the fill-only
 * `generateContentForReleases` primitive repopulates it). The summarizer itself is
 * injected as `deps.generate`, so this test does no AI calls.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, inArray } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { runGenerateContent } from "../src/routes/workflows.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

async function seed(db: ReturnType<typeof mkDb>, opts: { autoGen?: boolean } = {}) {
  await db.insert(organizations).values({
    id: "org_g",
    slug: "genco",
    name: "GenCo",
    category: "developer-tools",
    autoGenerateContent: opts.autoGen ?? true,
  });
  await db.insert(sources).values({
    id: "src_g",
    orgId: "org_g",
    slug: "genco-blog",
    name: "GenCo Blog",
    type: "feed",
    url: "https://genco.test",
  });
  // rel_1 / rel_3 lack generated content; rel_2 already has it.
  await db.insert(releases).values([
    { id: "rel_1", sourceId: "src_g", title: "One", content: "body one", titleGenerated: null },
    {
      id: "rel_2",
      sourceId: "src_g",
      title: "Two",
      content: "body two",
      titleGenerated: "Gen Two",
      titleShort: "Two",
      summary: "sum two",
    },
    { id: "rel_3", sourceId: "src_g", title: "Three", content: "body three", titleGenerated: null },
  ]);
  const [src] = await db.select().from(sources).where(eq(sources.id, "src_g"));
  return src;
}

/** Simulate generateContentForReleases by populating generated fields on the passed ids. */
function makeGenerate(db: ReturnType<typeof mkDb>) {
  const calls: string[][] = [];
  const fn = async (ids: string[]) => {
    calls.push(ids);
    if (ids.length) {
      await db
        .update(releases)
        .set({ titleGenerated: "GEN", titleShort: "G", summary: "S" })
        .where(inArray(releases.id, ids));
    }
  };
  return { fn, calls };
}

/** No-op summarizer: lets a regenerate run observe the NULLing without repopulation. */
const noopGenerate = async (_ids: string[]) => {};

describe("runGenerateContent", () => {
  it("fill mode (default) selects only releases lacking generated content", async () => {
    const db = mkDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { regenerate: false, limit: 25, dryRun: false },
      { generate: g.fn },
    );
    expect(report.scanned).toBe(2);
    expect(g.calls.flat().toSorted()).toEqual(["rel_1", "rel_3"]);
    expect(report.generated).toBe(2);
    // rel_2 (already had content) is left untouched in fill mode.
    const [r2] = await db.select().from(releases).where(eq(releases.id, "rel_2"));
    expect(r2.titleGenerated).toBe("Gen Two");
  });

  it("dry run reports candidates without writing or invoking generate", async () => {
    const db = mkDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { regenerate: false, limit: 25, dryRun: true },
      { generate: g.fn },
    );
    expect(report.scanned).toBe(2);
    expect(report.dryRun).toBe(true);
    expect(g.calls.length).toBe(0);
    const [r1] = await db.select().from(releases).where(eq(releases.id, "rel_1"));
    expect(r1.titleGenerated).toBeNull();
  });

  it("regenerate mode selects all eligible rows and NULLs existing content first", async () => {
    const db = mkDb();
    const src = await seed(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { regenerate: true, limit: 25, dryRun: false },
      { generate: noopGenerate },
    );
    expect(report.scanned).toBe(3);
    // rel_2's prior generated content was cleared so the fill-only primitive repopulates it.
    const [r2] = await db.select().from(releases).where(eq(releases.id, "rel_2"));
    expect(r2.titleGenerated).toBeNull();
    expect(r2.summary).toBeNull();
  });

  it("respects the eligibility gate (org auto_generate_content = false → no candidates)", async () => {
    const db = mkDb();
    const src = await seed(db, { autoGen: false });
    const g = makeGenerate(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { regenerate: true, limit: 25, dryRun: false },
      { generate: g.fn },
    );
    expect(report.scanned).toBe(0);
    expect(g.calls.length).toBe(0);
  });

  it("scopes to explicit releaseIds when provided", async () => {
    const db = mkDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { releaseIds: ["rel_1"], regenerate: false, limit: 25, dryRun: false },
      { generate: g.fn },
    );
    expect(report.scanned).toBe(1);
    expect(g.calls.flat()).toEqual(["rel_1"]);
  });

  it("caps candidates at limit", async () => {
    const db = mkDb();
    const src = await seed(db);
    const g = makeGenerate(db);
    const report = await runGenerateContent(
      db,
      { id: src.id },
      { regenerate: false, limit: 1, dryRun: false },
      { generate: g.fn },
    );
    expect(report.scanned).toBe(1);
  });
});
