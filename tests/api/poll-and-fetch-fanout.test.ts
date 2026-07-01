import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";

/**
 * Covers the SourceActor re-seed heartbeat in `fanOutPollAndFetch` (#1776): every
 * due source's actor gets `ensureScheduled` (idempotent — no-op when it already
 * has a pending alarm), seeded in bounded-concurrency waves; nothing is fanned
 * out to a workflow anymore (the actor drives its own ingest). When the
 * `SOURCE_ACTOR` binding is absent (local dev), the heartbeat seeds nothing.
 *
 * We can't call the real `fanOutPollAndFetch` (it resolves `drizzle(env.DB)`
 * against a D1 binding, and we drive a bun:sqlite DB), so the replica below
 * mirrors the prod loop shape and exercises the real `queryDueSources`.
 */

const ENSURE_CONCURRENCY = 20; // mirrors SOURCE_ACTOR_ENSURE_CONCURRENCY in index.ts

function mkFakeActorNamespace() {
  const ensured: string[] = [];
  const maxWave = { value: 0 };
  return {
    ensured,
    maxWave,
    binding: {
      getByName(_id: string) {
        return {
          async ensureScheduled(sourceId: string) {
            ensured.push(sourceId);
          },
        };
      },
    },
  };
}

async function seedSources(
  db: ReturnType<typeof drizzle>,
  count: number,
  tier: "normal" | "low" = "normal",
) {
  await db.insert(organizations).values({
    id: "org_test",
    slug: "test",
    name: "Test Org",
    createdAt: new Date().toISOString(),
  });
  const staleIso = "2020-01-01T00:00:00.000Z";
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      db.insert(sources).values({
        id: `src_test_${String(i).padStart(4, "0")}`,
        orgId: "org_test",
        type: "github",
        slug: `src-${i}`,
        name: `Source ${i}`,
        url: `https://example.com/${i}`,
        fetchPriority: tier,
        lastPolledAt: staleIso,
        createdAt: staleIso,
      }),
    ),
  );
}

describe("fanOutPollAndFetch SourceActor heartbeat", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    db = drizzle(sqlite);
  });

  // Reimplementation kept in sync with `workers/api/src/index.ts`. Binding-absent
  // returns without seeding; otherwise every due source is `ensureScheduled` in
  // bounded waves.
  async function heartbeatReplica(actor: ReturnType<typeof mkFakeActorNamespace> | null) {
    const { queryDueSources } = await import("../../workers/api/src/cron/poll-fetch");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dueAll = await queryDueSources(db as any, new Date(), { changeDetectEnabled: true });
    if (dueAll.length === 0) return;
    if (!actor) return; // binding absent → nothing to drive
    for (let i = 0; i < dueAll.length; i += ENSURE_CONCURRENCY) {
      const batch = dueAll.slice(i, i + ENSURE_CONCURRENCY);
      actor.maxWave.value = Math.max(actor.maxWave.value, batch.length);
      // oxlint-disable-next-line no-await-in-loop -- mirrors the prod heartbeat's bounded waves
      await Promise.all(batch.map((s) => actor.binding.getByName(s.id).ensureScheduled(s.id)));
    }
  }

  it("seeds every due source's actor exactly once", async () => {
    await seedSources(db, 42);
    const actor = mkFakeActorNamespace();
    await heartbeatReplica(actor);
    expect(actor.ensured).toHaveLength(42);
    expect(new Set(actor.ensured).size).toBe(42);
  });

  it("seeds all due sources across many bounded waves without dropping any", async () => {
    await seedSources(db, 163);
    const actor = mkFakeActorNamespace();
    await heartbeatReplica(actor);
    expect(actor.ensured).toHaveLength(163);
    expect(new Set(actor.ensured).size).toBe(163);
    // Each wave stays within the concurrency bound.
    expect(actor.maxWave.value).toBeLessThanOrEqual(ENSURE_CONCURRENCY);
  });

  it("seeds nothing when the SOURCE_ACTOR binding is absent", async () => {
    await seedSources(db, 30);
    const actor = mkFakeActorNamespace();
    await heartbeatReplica(null);
    expect(actor.ensured).toHaveLength(0);
  });

  it("is a no-op when there are no due sources", async () => {
    const actor = mkFakeActorNamespace();
    await heartbeatReplica(actor);
    expect(actor.ensured).toHaveLength(0);
  });
});
