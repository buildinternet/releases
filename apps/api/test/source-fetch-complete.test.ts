import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, and } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, knowledgePages } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { completeSourceFetch } from "../src/lib/source-fetch-complete.js";

// Direct coverage of the extracted fetch-completion write (#1946 phase 4, task
// 5) — mirrors the narrow field set `PATCH /sources/:id` writes for this
// caller today (sources.ts ~2722), plus the same fire-and-forget playbook
// regen the route triggers on every PATCH.

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

async function seedOrgAndSource(db: D1Db) {
  await db.insert(organizations).values({
    id: "org_a",
    slug: "acme",
    name: "Acme",
    category: "cloud",
    discovery: "curated",
  });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/changelog",
    type: "scrape",
    lastFetchedAt: null,
    changeDetectedAt: "2026-07-01T00:00:00.000Z",
    consecutiveErrors: 3,
    consecutiveNoChange: 5,
    nextFetchAfter: "2026-07-10T00:00:00.000Z",
  });
}

async function readSource(db: D1Db) {
  const [row] = await db
    .select({
      lastFetchedAt: sources.lastFetchedAt,
      changeDetectedAt: sources.changeDetectedAt,
      consecutiveErrors: sources.consecutiveErrors,
      consecutiveNoChange: sources.consecutiveNoChange,
      nextFetchAfter: sources.nextFetchAfter,
    })
    .from(sources)
    .where(eq(sources.id, "src_a1"));
  return row;
}

async function readPlaybook(db: D1Db, orgId: string) {
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, orgId)));
  return row;
}

describe("completeSourceFetch", () => {
  it("resets the fetch-completion counters and regenerates the org playbook", async () => {
    const db = mkDb();
    await seedOrgAndSource(db);

    await completeSourceFetch(db, { id: "src_a1", orgId: "org_a" });

    const row = await readSource(db);
    expect(row?.lastFetchedAt).toBeTruthy();
    expect(row?.changeDetectedAt).toBeNull();
    expect(row?.consecutiveErrors).toBe(0);
    expect(row?.consecutiveNoChange).toBe(0);
    expect(row?.nextFetchAfter).toBeNull();

    const playbook = await readPlaybook(db, "org_a");
    expect(playbook).toBeTruthy();
    expect(playbook?.content).toContain("Acme");
  });

  it("skips playbook regen when orgId is null (defensive — sources.org_id is NOT NULL in prod, but the type allows it)", async () => {
    const db = mkDb();
    await seedOrgAndSource(db);

    // Passing orgId: null here exercises the `if (src.orgId)` guard directly
    // rather than seeding an impossible orgless row (sources.org_id is
    // NOT NULL in the schema).
    await completeSourceFetch(db, { id: "src_a1", orgId: null });

    const row = await readSource(db);
    expect(row?.consecutiveErrors).toBe(0);
    const playbook = await readPlaybook(db, "org_a");
    expect(playbook).toBeFalsy();
  });

  it("defers to opts.waitUntil instead of awaiting the regen when provided", async () => {
    const db = mkDb();
    await seedOrgAndSource(db);

    const scheduled: Promise<unknown>[] = [];
    await completeSourceFetch(
      db,
      { id: "src_a1", orgId: "org_a" },
      { waitUntil: (p) => scheduled.push(p) },
    );

    // The regen was handed off rather than awaited inline — give it a tick to
    // finish, then confirm it landed.
    expect(scheduled.length).toBe(1);
    await scheduled[0];
    const playbook = await readPlaybook(db, "org_a");
    expect(playbook).toBeTruthy();
  });
});
