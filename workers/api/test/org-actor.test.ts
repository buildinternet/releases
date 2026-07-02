import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { OrgActor, type OrgActorEnv } from "../src/org-actor.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_x", slug: "x", name: "X Corp", category: "productivity" })
    .run();
  return db;
}
type Db = ReturnType<typeof mkDb>;

function seedFlaggedScrape(
  db: Db,
  id: string,
  over: Partial<{ changeDetectedAt: string | null; fetchPriority: string; metadata: string }> = {},
) {
  db.insert(sources)
    .values({
      id,
      orgId: "org_x",
      slug: id,
      name: id,
      type: "scrape",
      url: `https://example.com/${id}`,
      metadata: over.metadata ?? "{}",
      fetchPriority: (over.fetchPriority as any) ?? "normal",
      changeDetectedAt:
        over.changeDetectedAt === undefined ? new Date().toISOString() : over.changeDetectedAt,
      lastFetchedAt: null,
    })
    .run();
}

function mkActor(db: Db, updateImpl?: (body: any) => Response, opts: { drainOn?: boolean } = {}) {
  let alarm: number | null = null;
  const store = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (keys: string[]) => {
      for (const k of keys) store.delete(k);
    },
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => void (alarm = t),
    deleteAlarm: async () => void (alarm = null),
  } as unknown as DurableObjectStorage;
  const ctx = { storage } as unknown as DurableObjectState;
  const dispatched: any[] = [];
  const env: OrgActorEnv = {
    DB: {} as D1Database,
    _drizzleOverride: db,
    // Kill switch defaults ON in the harness so dispatch tests exercise the
    // drain; a dedicated test flips it off. `flag()` reads this var (no FLAGS
    // binding needed) via its var fallback.
    ORG_DRAIN_ACTOR_ENABLED: opts.drainOn === false ? "false" : "true",
    RELEASES_API_KEY: { get: async () => "k" },
    DISCOVERY_WORKER: {
      fetch: async (_i: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        dispatched.push(body);
        return updateImpl
          ? updateImpl(body)
          : new Response(JSON.stringify({ sessionId: "ma-1" }), { status: 200 });
      },
    },
  };
  const actor = new (OrgActor as any)(ctx, env);
  return { actor, alarmAt: () => alarm, dispatched };
}

describe("OrgActor", () => {
  it("ensureDrainScheduled arms the alarm once (idempotent)", async () => {
    const db = mkDb();
    const h = mkActor(db);
    await h.actor.ensureDrainScheduled("org_x");
    const first = h.alarmAt();
    expect(first).not.toBeNull();
    await h.actor.ensureDrainScheduled("org_x");
    expect(h.alarmAt()).toBe(first); // not re-armed
  });

  it("alarm dispatches ONE /update for the org's flagged sources", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_a");
    seedFlaggedScrape(db, "src_b");
    const h = mkActor(db);
    await h.actor.ensureDrainScheduled("org_x");
    await h.actor.alarm();
    expect(h.dispatched.length).toBe(1);
    expect(h.dispatched[0].orgId).toBe("org_x");
    expect(h.dispatched[0].company).toBe("X Corp");
    expect(new Set(h.dispatched[0].sourceIdentifiers)).toEqual(new Set(["src_a", "src_b"]));
    expect(h.alarmAt()).toBeNull(); // cleared after dispatch
  });

  it("alarm no-ops (clears) when no flagged candidates", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_clean", { changeDetectedAt: null });
    const h = mkActor(db);
    await h.actor.ensureDrainScheduled("org_x");
    await h.actor.alarm();
    expect(h.dispatched.length).toBe(0);
    expect(h.alarmAt()).toBeNull();
  });

  it("excludes paused sources from the drain", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_paused", { fetchPriority: "paused" });
    const h = mkActor(db);
    await h.actor.ensureDrainScheduled("org_x");
    await h.actor.alarm();
    expect(h.dispatched.length).toBe(0);
  });

  // Capture the JSON logEvent lines a run emits, by severity (info→log, warn→warn).
  async function captureLogs(fn: () => Promise<void>) {
    const info: any[] = [];
    const warn: any[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const parse = (sink: any[]) => (line?: unknown) => {
      try {
        sink.push(JSON.parse(String(line)));
      } catch {
        /* non-JSON line, ignore */
      }
    };
    console.log = parse(info) as typeof console.log;
    console.warn = parse(warn) as typeof console.warn;
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    return { info, warn };
  }

  it("classifies a 409 (scrape lock held) as drain-superseded, not drain-failed", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_a");
    const h = mkActor(
      db,
      () =>
        new Response("Source src_a has an active MA session (ma-abc)", {
          status: 409,
          headers: { "Retry-After": "900" },
        }),
    );
    await h.actor.ensureDrainScheduled("org_x");
    const { info, warn } = await captureLogs(() => h.actor.alarm()); // must not throw
    expect(h.dispatched.length).toBe(1);
    expect(h.alarmAt()).toBeNull();
    // Benign race: emitted at info level as drain-superseded, never as an error.
    expect(info.some((l) => l.event === "drain-superseded" && l.status === 409)).toBe(true);
    expect(warn.some((l) => l.event === "drain-failed")).toBe(false);
  });

  it("classifies a non-409 error (spend cap 429) as drain-failed", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_a");
    const h = mkActor(
      db,
      () =>
        new Response(JSON.stringify({ error: "Daily global spend cap reached" }), { status: 429 }),
    );
    await h.actor.ensureDrainScheduled("org_x");
    const { info, warn } = await captureLogs(() => h.actor.alarm()); // must not throw
    expect(h.dispatched.length).toBe(1);
    expect(h.alarmAt()).toBeNull();
    expect(warn.some((l) => l.event === "drain-failed" && l.status === 429)).toBe(true);
    expect(info.some((l) => l.event === "drain-superseded")).toBe(false);
  });

  it("does NOT dispatch when the kill switch is off at alarm time", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_a");
    // Armed while (hypothetically) on, but the flag is off when the alarm fires.
    const h = mkActor(db, undefined, { drainOn: false });
    await h.actor.ensureDrainScheduled("org_x");
    await h.actor.alarm();
    expect(h.dispatched.length).toBe(0);
    expect(h.alarmAt()).toBeNull(); // alarm still cleared → actor goes dormant
  });
});
