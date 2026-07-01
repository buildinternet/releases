/**
 * SourceActor DO (#1776): unit tests over a fake DurableObjectState (in-memory
 * storage + alarm) backed by a real bun:sqlite D1 so the alarm exercises the
 * actual `computeFetchState` due/backoff math and the `json_set` mirror write.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { SourceActor, type SourceActorEnv } from "../src/source-actor.js";

const HOUR = 3_600_000;

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_x", slug: "x", name: "X", category: "productivity" })
    .run();
  return db;
}

type Db = ReturnType<typeof mkDb>;

function seedSource(
  db: Db,
  id: string,
  overrides: Partial<{
    fetchPriority: "normal" | "low" | "paused";
    lastPolledAt: string | null;
    nextFetchAfter: string | null;
    metadata: string;
  }> = {},
) {
  db.insert(sources)
    .values({
      id,
      orgId: "org_x",
      slug: id,
      name: id,
      type: "feed",
      url: `https://example.com/${id}`,
      metadata:
        overrides.metadata ??
        JSON.stringify({ feedUrl: `https://example.com/${id}/feed.xml`, feedType: "rss" }),
      fetchPriority: overrides.fetchPriority ?? "normal",
      lastPolledAt: overrides.lastPolledAt ?? null,
      nextFetchAfter: overrides.nextFetchAfter ?? null,
    })
    .run();
}

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actor: any;
  store: Map<string, unknown>;
  alarmAt: () => number | null;
  created: Array<{ id: string; params: unknown }>;
  setEnabled: (v: boolean) => void;
}

function mkActor(
  db: Db,
  opts: { enabled?: boolean; cohortPct?: string; failCreateIds?: Set<string> } = {},
  store: Map<string, unknown> = new Map(),
): Harness {
  let alarm: number | null = null;
  const created: Array<{ id: string; params: unknown }> = [];
  const storage = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) store.delete(k);
    },
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => {
      alarm = t;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;

  const ctx = { storage } as unknown as DurableObjectState;

  let enabled = opts.enabled ?? true;
  const env: SourceActorEnv = {
    DB: {} as D1Database,
    _drizzleOverride: db,
    SOURCE_ACTOR_ENABLED: enabled ? "true" : "false",
    SOURCE_ACTOR_COHORT_PCT: opts.cohortPct ?? "100",
    POLL_AND_FETCH_WORKFLOW: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (o: any) => {
        if (opts.failCreateIds?.has(o.id)) throw new Error(`duplicate instance id: ${o.id}`);
        created.push({ id: o.id, params: o.params });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor = new (SourceActor as any)(ctx, env);
  return {
    actor,
    store,
    alarmAt: () => alarm,
    created,
    setEnabled: (v: boolean) => {
      enabled = v;
      env.SOURCE_ACTOR_ENABLED = v ? "true" : "false";
    },
  };
}

async function metaSourceActor(db: Db, id: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  const meta = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  return (meta.sourceActor as Record<string, unknown> | undefined) ?? null;
}

describe("SourceActor.alarm", () => {
  it("fires the workflow once when due and schedules ~one tier interval out", async () => {
    const db = mkDb();
    // Polled 10h ago on a 4h tier → due.
    seedSource(db, "src_due", { lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString() });
    const h = mkActor(db);
    h.store.set("sourceId", "src_due");

    const before = Date.now();
    await h.actor.alarm();

    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.params).toMatchObject({ sourceId: "src_due" });
    const alarm = h.alarmAt()!;
    expect(alarm).toBeGreaterThan(before + 3.5 * HOUR);
    expect(alarm).toBeLessThan(before + 4.5 * HOUR);

    const state = await h.actor.getState();
    expect(state.inFlight).toBe(true);
    expect(state.tier).toBe("normal");

    const mirror = await metaSourceActor(db, "src_due");
    expect(mirror?.managed).toBe(true);
    expect(typeof mirror?.nextAlarmAt).toBe("string");
  });

  it("does not fetch when not yet due — reschedules to nextDueAt", async () => {
    const db = mkDb();
    // Polled 1h ago on a 4h tier → due in ~3h, not now.
    seedSource(db, "src_fresh", { lastPolledAt: new Date(Date.now() - 1 * HOUR).toISOString() });
    const h = mkActor(db);
    h.store.set("sourceId", "src_fresh");

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    const alarm = h.alarmAt()!;
    expect(alarm).toBeGreaterThan(Date.now() + 2.5 * HOUR);
  });

  it("honors smart-fetch backoff (future nextFetchAfter) without fetching", async () => {
    const db = mkDb();
    seedSource(db, "src_backoff", {
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(), // tier-due
      nextFetchAfter: new Date(Date.now() + 20 * HOUR).toISOString(), // but backed off
    });
    const h = mkActor(db);
    h.store.set("sourceId", "src_backoff");

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    const alarm = h.alarmAt()!;
    expect(alarm).toBeGreaterThan(Date.now() + 19 * HOUR);
  });

  it("fetches a never-polled source immediately on its first alarm", async () => {
    const db = mkDb();
    // lastPolledAt defaults to null (never polled) — the cron seeds it as due, so
    // the actor must fetch now, not push out a full tier interval.
    seedSource(db, "src_new");
    const h = mkActor(db);
    h.store.set("sourceId", "src_new");

    await h.actor.alarm();

    expect(h.created).toHaveLength(1);
  });

  it("never-polled but backed off waits for nextFetchAfter", async () => {
    const db = mkDb();
    seedSource(db, "src_new_backoff", {
      lastPolledAt: null,
      nextFetchAfter: new Date(Date.now() + 12 * HOUR).toISOString(),
    });
    const h = mkActor(db);
    h.store.set("sourceId", "src_new_backoff");

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    expect(h.alarmAt()!).toBeGreaterThan(Date.now() + 11 * HOUR);
  });

  it("paused source does not fetch or reschedule, and clears the D1 mirror", async () => {
    const db = mkDb();
    seedSource(db, "src_paused", {
      fetchPriority: "paused",
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(),
    });
    const h = mkActor(db);
    h.store.set("sourceId", "src_paused");

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    expect(h.alarmAt()).toBeNull();
    const mirror = await metaSourceActor(db, "src_paused");
    expect(mirror?.managed).toBe(false);
    expect(mirror?.nextAlarmAt).toBeNull();
  });

  it("in-flight guard: a second immediate alarm does not double-fire", async () => {
    const db = mkDb();
    seedSource(db, "src_inflight", {
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(),
    });
    const h = mkActor(db);
    h.store.set("sourceId", "src_inflight");

    await h.actor.alarm(); // fires once
    // D1 not advanced (stubbed workflow), so still "due" — guard must hold.
    await h.actor.alarm();

    expect(h.created).toHaveLength(1);
  });

  it("low tier schedules ~24h out", async () => {
    const db = mkDb();
    seedSource(db, "src_low", {
      fetchPriority: "low",
      lastPolledAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    });
    const h = mkActor(db);
    h.store.set("sourceId", "src_low");

    const before = Date.now();
    await h.actor.alarm();

    expect(h.created).toHaveLength(1);
    const alarm = h.alarmAt()!;
    expect(alarm).toBeGreaterThan(before + 23 * HOUR);
    expect(alarm).toBeLessThan(before + 25 * HOUR);
  });

  it("hands the source back to the cron when no longer managed", async () => {
    const db = mkDb();
    seedSource(db, "src_unmanage", {
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(),
    });
    const h = mkActor(db, { enabled: false });
    h.store.set("sourceId", "src_unmanage");
    // Pre-seed an alarm so we can assert it gets cleared.
    await (h.actor.ctx.storage as DurableObjectStorage).setAlarm(Date.now() + HOUR);

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    expect(h.alarmAt()).toBeNull();
    expect(await h.actor.getState()).toBeNull();
    const mirror = await metaSourceActor(db, "src_unmanage");
    expect(mirror?.managed).toBe(false);
  });

  it("stops when the source row is gone", async () => {
    const db = mkDb();
    const h = mkActor(db);
    h.store.set("sourceId", "src_missing");

    await h.actor.alarm();

    expect(h.created).toHaveLength(0);
    expect(h.alarmAt()).toBeNull();
  });

  it("rehydrates from D1 on a fresh instance sharing only storage", async () => {
    const db = mkDb();
    seedSource(db, "src_rehydrate", {
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(),
    });
    const store = new Map<string, unknown>();
    const first = mkActor(db, {}, store);
    await first.actor.ensureScheduled("src_rehydrate");

    // A fresh instance (in-memory state lost) sharing only the persisted storage.
    const second = mkActor(db, {}, store);
    await second.actor.alarm();

    expect(second.created).toHaveLength(1);
    expect(second.created[0]!.params).toMatchObject({ sourceId: "src_rehydrate" });
  });
});

describe("SourceActor.ensureScheduled", () => {
  it("seeds an alarm once and is idempotent", async () => {
    const db = mkDb();
    seedSource(db, "src_seed", { lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString() });
    const h = mkActor(db);

    await h.actor.ensureScheduled("src_seed");
    const first = h.alarmAt();
    expect(first).not.toBeNull();
    expect(h.store.get("sourceId")).toBe("src_seed");

    await h.actor.ensureScheduled("src_seed");
    expect(h.alarmAt()).toBe(first); // unchanged — no-op when an alarm is pending
  });
});

describe("SourceActor.onSourceChanged", () => {
  it("persists the id and pulls the alarm in to re-evaluate", async () => {
    const db = mkDb();
    seedSource(db, "src_changed", {
      lastPolledAt: new Date(Date.now() - 10 * HOUR).toISOString(),
    });
    const h = mkActor(db);

    await h.actor.onSourceChanged("src_changed");
    expect(h.store.get("sourceId")).toBe("src_changed");
    expect(h.alarmAt()).not.toBeNull();
  });
});

describe("SourceActor scrape-lock (#1814)", () => {
  // The lock methods touch only DO storage, so a bare actor (no seeded source,
  // no scheduled alarm) exercises them — the DO is created purely for the lock,
  // as it is when the discovery worker `get(idFromName(sourceId))`s an unmanaged
  // source.
  it("acquires a free source and reports the owning sessionId", async () => {
    const h = mkActor(mkDb());
    expect(await h.actor.tryAcquireScrapeLock("src_a", "sess_1")).toEqual({
      acquired: true,
      sessionId: "sess_1",
    });
    const lock = h.store.get("scrapeLock") as { sessionId: string; expiresAt: number };
    expect(lock.sessionId).toBe("sess_1");
    expect(lock.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses a contended source without overwriting the live lease", async () => {
    const h = mkActor(mkDb());
    await h.actor.tryAcquireScrapeLock("src_a", "sess_1");
    // A second attempt while sess_1's lease is live is rejected and returns the
    // current owner — the lease is NOT overwritten.
    expect(await h.actor.tryAcquireScrapeLock("src_a", "sess_2")).toEqual({
      acquired: false,
      sessionId: "sess_1",
    });
    expect((h.store.get("scrapeLock") as { sessionId: string }).sessionId).toBe("sess_1");
  });

  it("reclaims a lease past its deadline", async () => {
    const h = mkActor(mkDb());
    // Simulate a session that died before releasing: lease deadline in the past.
    h.store.set("scrapeLock", { sessionId: "sess_dead", expiresAt: Date.now() - 1 });
    expect(await h.actor.tryAcquireScrapeLock("src_a", "sess_new")).toEqual({
      acquired: true,
      sessionId: "sess_new",
    });
    expect((h.store.get("scrapeLock") as { sessionId: string }).sessionId).toBe("sess_new");
  });

  it("release clears the lease when the caller owns it", async () => {
    const h = mkActor(mkDb());
    await h.actor.tryAcquireScrapeLock("src_a", "sess_1");
    await h.actor.releaseScrapeLock("src_a", "sess_1");
    expect(h.store.get("scrapeLock")).toBeUndefined();
    // Freed — a fresh acquire succeeds.
    expect((await h.actor.tryAcquireScrapeLock("src_a", "sess_2")).acquired).toBe(true);
  });

  it("release is a no-op when a newer owner holds the lease", async () => {
    const h = mkActor(mkDb());
    // sess_1's lease expired and sess_2 re-claimed the source; sess_1's late
    // release must not clobber sess_2's live lease.
    await h.actor.tryAcquireScrapeLock("src_a", "sess_2");
    await h.actor.releaseScrapeLock("src_a", "sess_1");
    expect((h.store.get("scrapeLock") as { sessionId: string }).sessionId).toBe("sess_2");
  });
});
