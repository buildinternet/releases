import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";

/**
 * Covers the `createBatch` chunking in `fanOutPollAndFetch`. The control-plane
 * API caps each call at 100 instances — without chunking the whole fan-out
 * fails silently inside `ctx.waitUntil`. See #486.
 *
 * We shadow `drizzle-orm/d1`'s `drizzle(env.DB)` by seeding a bun:sqlite DB
 * and passing it in via the workflow's `_drizzleOverride` pattern — but since
 * `fanOutPollAndFetch` doesn't expose that hook, we instead stub it via the
 * module-level drizzle factory: pass the seeded DB as `env.DB` after casting,
 * rely on drizzle/d1's polymorphic behavior — but bun:sqlite isn't a D1
 * surface, so we take a simpler route: call `queryDueSources` directly and
 * replicate the `fanOutPollAndFetch` shape inline, then assert on the stub
 * binding. This keeps the test independent of `drizzle(env.DB)` resolution.
 */

type CapturedBatch = Array<{ id: string; params: { sourceId: string; scheduledTime: number } }>;

function mkFakeWorkflow() {
  const calls: CapturedBatch[] = [];
  return {
    calls,
    binding: {
      async createBatch(batch: CapturedBatch) {
        if (batch.length > 100) {
          throw new Error("Batch size execeeds maximum allowed");
        }
        calls.push(batch);
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

describe("fanOutPollAndFetch chunking", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    db = drizzle(sqlite);
  });

  // Reimplementation kept in sync with `workers/api/src/index.ts`. We can't
  // call the real `fanOutPollAndFetch` because it resolves `drizzle(env.DB)`
  // against a D1 binding, and we want to drive it against a bun:sqlite DB.
  async function fanOutReplica(
    workflow: ReturnType<typeof mkFakeWorkflow>["binding"],
    scheduledTime: number,
    MAX = 100,
  ) {
    const { queryDueSources } = await import("../../workers/api/src/cron/poll-fetch");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const due = await queryDueSources(db as any, new Date());
    if (due.length === 0) return;
    const params = due.map((s) => ({
      id: `poll-fetch-${scheduledTime}-${s.id}`,
      params: { sourceId: s.id, scheduledTime },
    }));
    for (let i = 0; i < params.length; i += MAX) {
      // oxlint-disable-next-line no-await-in-loop -- mirrors the prod fan-out which chunks sequentially against the control-plane
      await workflow.createBatch(params.slice(i, i + MAX));
    }
  }

  it("sends a single chunk when count <= 100", async () => {
    await seedSources(db, 42);
    const wf = mkFakeWorkflow();
    await fanOutReplica(wf.binding, 1_700_000_000_000);
    expect(wf.calls).toHaveLength(1);
    expect(wf.calls[0]).toHaveLength(42);
  });

  it("chunks into multiple createBatch calls when count > 100", async () => {
    await seedSources(db, 163);
    const wf = mkFakeWorkflow();
    await fanOutReplica(wf.binding, 1_700_000_000_000);
    expect(wf.calls).toHaveLength(2);
    expect(wf.calls[0]).toHaveLength(100);
    expect(wf.calls[1]).toHaveLength(63);
  });

  it("handles exact multiples of 100 without empty tail chunks", async () => {
    await seedSources(db, 200);
    const wf = mkFakeWorkflow();
    await fanOutReplica(wf.binding, 1_700_000_000_000);
    expect(wf.calls).toHaveLength(2);
    expect(wf.calls[0]).toHaveLength(100);
    expect(wf.calls[1]).toHaveLength(100);
  });

  it("emits unique instance IDs across chunks", async () => {
    await seedSources(db, 250);
    const wf = mkFakeWorkflow();
    await fanOutReplica(wf.binding, 1_700_000_000_000);
    const allIds = wf.calls.flat().map((p) => p.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

/**
 * SourceActor cohort partition (#1776). Mirrors the split `fanOutPollAndFetch`
 * applies to the due list: actor-managed sources go to `ensureScheduled` (NOT
 * the workflow fan-out — no double-driving), everyone else still fans out. We
 * exercise the REAL `isSourceActorManaged` predicate so the test fails if the
 * gating logic drifts; the surrounding loop replicates the prod shape for the
 * same reason the chunking replica above does (can't resolve `drizzle(env.DB)`).
 */
describe("fanOutPollAndFetch SourceActor cohort partition", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    db = drizzle(sqlite);
  });

  async function partitionReplica(opts: {
    enabledVar: string | undefined;
    cohortPctVar: string | undefined;
    hasBinding: boolean;
  }) {
    const { queryDueSources } = await import("../../workers/api/src/cron/poll-fetch");
    const { isSourceActorManaged, parseCohortPct } =
      await import("../../workers/api/src/lib/source-actor-cohort");
    const { flag, FLAGS } = await import("@releases/lib/flags");

    // Mirror production's options (fanOutPollAndFetch passes changeDetectEnabled).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dueAll = await queryDueSources(db as any, new Date(), { changeDetectEnabled: true });
    const enabled = await flag(undefined, opts.enabledVar, FLAGS.sourceActorEnabled);
    const pct = parseCohortPct(opts.cohortPctVar);
    const ensured: string[] = [];
    const fannedOut: string[] = [];
    for (const s of dueAll) {
      if (isSourceActorManaged(s.id, enabled, pct, opts.hasBinding)) ensured.push(s.id);
      else fannedOut.push(s.id);
    }
    return { ensured, fannedOut, total: dueAll.length };
  }

  it("routes all due sources to ensureScheduled at 100% cohort with the flag on", async () => {
    await seedSources(db, 30);
    const r = await partitionReplica({ enabledVar: "true", cohortPctVar: "100", hasBinding: true });
    expect(r.ensured).toHaveLength(30);
    expect(r.fannedOut).toHaveLength(0);
  });

  it("keeps every source on the cron fan-out when the flag is off", async () => {
    await seedSources(db, 30);
    const r = await partitionReplica({
      enabledVar: "false",
      cohortPctVar: "100",
      hasBinding: true,
    });
    expect(r.ensured).toHaveLength(0);
    expect(r.fannedOut).toHaveLength(30);
  });

  it("keeps every source on the cron fan-out when the binding is absent", async () => {
    await seedSources(db, 30);
    const r = await partitionReplica({
      enabledVar: "true",
      cohortPctVar: "100",
      hasBinding: false,
    });
    expect(r.ensured).toHaveLength(0);
    expect(r.fannedOut).toHaveLength(30);
  });

  it("splits the due list at a partial cohort (managed + fan-out are disjoint, sum to total)", async () => {
    await seedSources(db, 60);
    const r = await partitionReplica({ enabledVar: "true", cohortPctVar: "50", hasBinding: true });
    expect(r.ensured.length + r.fannedOut.length).toBe(r.total);
    expect(r.ensured.length).toBeGreaterThan(0);
    expect(r.fannedOut.length).toBeGreaterThan(0);
  });
});
