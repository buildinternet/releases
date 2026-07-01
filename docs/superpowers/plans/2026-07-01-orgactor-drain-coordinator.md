# OrgActor Drain Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the `scrape-agent-sweep` (#482) and `force-drain-sweep` (#518) crons by moving the _producer_ (flag stranded scrape/agent sources) into the `SourceActor` poll path and the _consumer_ (dispatch one per-org `/update` managed-agent session) into a new per-org `OrgActor` Durable Object.

**Architecture:** Two components behind one kill-switch flag. (1) The poll path self-flags stranded scrape/agent sources (`changeDetectedAt = now`) when their change-detector is `unreliable` or they are stale > 72h — replacing the force-drain producer. (2) A new `OrgActor` DO, armed by the `SourceActor` alarm via `ensureDrainScheduled(orgId)`, queries its org's flagged sources and dispatches a single `/update` session — replacing the sweep consumer. No in-app budget: the discovery `/update` endpoint already enforces a per-org ($2/day) + global ($15/day) dollar spend cap (`checkSpendCap`, #1055) and the per-source scrape lock (#1815) before minting, so the actor just dispatches. Everything is gated by `org-drain-actor-enabled`; with the flag off, behavior is byte-for-byte today's.

**Tech Stack:** TypeScript (strict), Cloudflare Durable Objects + Workflows, Drizzle ORM over D1, Cloudflare Flagship feature flags (`@releases/lib/flags`), `bun test`, oxlint/oxfmt.

## Global Constraints

- **Ship the flag OFF.** `org-drain-actor-enabled` default `false`. With it off, the poll path does not self-flag, the `SourceActor` does not notify, the `OrgActor` is never armed, and both crons run exactly as today. This must remain true after every task.
- **Flagship key parity:** the key `org-drain-actor-enabled` must be created (default OFF) in BOTH Flagship apps — `releases-platform` and `releases-platform-staging` — before it is flipped on. This is a manual post-merge step, not code.
- **Never edit real env files** (`.env`, `.dev.vars`, secrets). Only `wrangler.jsonc` and source/test files.
- **Worker logging** uses `logEvent()` from `@releases/lib/log-event` (never the `fs`-backed logger).
- **DO addressing** uses `getByName(name)`.
- **Do not touch `workers/mcp`** — its `tsc` has pre-existing unrelated zod-split noise; leave it be.
- **Green gates per task:** `bun run check` (lint + typecheck + format) clean; `bun test workers/api` and `bun test tests/` pass.
- **Commit identity:** `git -c user.email=zach@buildinternet.com commit`.
- **D1:** the `OrgActor` candidate query is single-org and `LIMIT 20`, well under the 100-bind ceiling. Do not widen it to multi-org.

## File Structure

- `packages/lib/src/flags.ts` — **modify:** add the `orgDrainActorEnabled` registry entry.
- `workers/api/src/cron/poll-fetch.ts` — **modify:** add `isStale()` helper; thread a `drainSelfFlag` option through `pollOne` → `pollScrapeOrAgentByQuirk` + its `persistOutcome` helper (the producer, retires #518).
- `workers/api/src/workflows/poll-and-fetch.ts` — **modify:** add `FLAGS` / `ORG_DRAIN_ACTOR_ENABLED` / `FORCE_DRAIN_STALE_HOURS` to `PollAndFetchWorkflowEnv`; compute `drainSelfFlag` from the flag and pass it into `pollOne`.
- `workers/api/src/org-actor.ts` — **create:** the `OrgActor` DO (`ensureDrainScheduled` + `alarm`).
- `workers/api/test/org-actor.test.ts` — **create:** `OrgActor` unit tests.
- `workers/api/src/source-actor.ts` — **modify:** add `ORG_ACTOR` / `FLAGS` / `ORG_DRAIN_ACTOR_ENABLED` to `SourceActorEnv`; notify the `OrgActor` from `alarm()` when the loaded row is a flagged scrape/agent source.
- `workers/api/test/source-actor.test.ts` — **modify:** extend the harness with an `ORG_ACTOR` fake + flag; add notify tests.
- `workers/api/src/index.ts` — **modify:** export `OrgActor`; add the `ORG_ACTOR` binding to `Env`; gate both crons in `scheduled()`.
- `workers/api/src/cron/scrape-agent-sweep.ts` — **modify:** honor a `supersededByActor` early-return.
- `workers/api/src/cron/force-drain-sweep.ts` — **modify:** honor a `supersededByActor` early-return.
- `workers/api/wrangler.jsonc` — **modify:** register the `OrgActor` DO binding + `v4` migration in BOTH the top-level and `[env.staging]` blocks.
- `docs/architecture/remote-mode.md`, `AGENTS.md` — **modify:** document the actor-drain path + the flag.

---

### Task 1: Add the `org-drain-actor-enabled` flag

**Files:**

- Modify: `packages/lib/src/flags.ts` (append to the `FLAGS` object, after `oauthClientReaperEnabled`, ~line 147)
- Test: `workers/api/test/org-drain-flag.test.ts` (create)

**Interfaces:**

- Produces: `FLAGS.orgDrainActorEnabled: { key: "org-drain-actor-enabled"; env: "ORG_DRAIN_ACTOR_ENABLED"; default: false }` — consumed by Tasks 2, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-drain-flag.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { FLAGS, flag } from "@releases/lib/flags";

describe("orgDrainActorEnabled flag", () => {
  it("is registered with the right key/env/default", () => {
    expect(FLAGS.orgDrainActorEnabled).toEqual({
      key: "org-drain-actor-enabled",
      env: "ORG_DRAIN_ACTOR_ENABLED",
      default: false,
    });
  });

  it("defaults off with no binding and no var", async () => {
    expect(await flag(undefined, undefined, FLAGS.orgDrainActorEnabled)).toBe(false);
  });

  it("reads the wrangler var fallback when set", async () => {
    expect(await flag(undefined, "true", FLAGS.orgDrainActorEnabled)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/org-drain-flag.test.ts`
Expected: FAIL — `FLAGS.orgDrainActorEnabled` is `undefined`.

- [ ] **Step 3: Add the registry entry**

In `packages/lib/src/flags.ts`, immediately after the `oauthClientReaperEnabled` entry (before the closing `} as const satisfies ...`):

```ts
  // Rollout gate + kill switch for the actor-native scrape/agent drain
  // (OrgActor). default:false → OFF: the poll path does not self-flag, the
  // SourceActor does not notify an OrgActor, and the force-drain (#518) +
  // scrape-agent-sweep (#482) crons run as before. Flip ON in BOTH Flagship
  // apps to move the drain onto the actor path (the crons then early-return).
  // Roll back by flipping OFF — the crons resume next tick.
  orgDrainActorEnabled: {
    key: "org-drain-actor-enabled",
    env: "ORG_DRAIN_ACTOR_ENABLED",
    default: false,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/org-drain-flag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/flags.ts workers/api/test/org-drain-flag.test.ts
git -c user.email=zach@buildinternet.com commit -m "feat(flags): add org-drain-actor-enabled kill switch"
```

---

### Task 2: Producer — self-flag stranded scrape/agent sources in the poll path (retires #518)

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (`pollOne` opts ~364-373; `pollScrapeOrAgentByQuirk` ~493-544; its `persistOutcome` ~526-538; add `isStale` helper near the top of the scrape/agent section)
- Modify: `workers/api/src/workflows/poll-and-fetch.ts` (`PollAndFetchWorkflowEnv` ~59-99; the `poll-head-check` step ~532-542)
- Test: `workers/api/test/poll-fetch-change-detectors.test.ts` (add cases)

**Interfaces:**

- Consumes: `FLAGS.orgDrainActorEnabled` (Task 1).
- Produces: `pollOne(db, source, now, { drainSelfFlag?: { staleHours: number }, ... })` — when `drainSelfFlag` is present, a scrape/agent source with an `unreliable`/absent detector (or any detector but stale > `staleHours`) has `changeDetectedAt` set and `PollResult.changed === true`. Absent ⇒ today's behavior (unreliable/absent ⇒ no-op).

- [ ] **Step 1: Write the failing tests**

Add to `workers/api/test/poll-fetch-change-detectors.test.ts` (a new `describe` block; reuse the file's existing `mkDb`/`seedSource` helpers — match their signatures in that file):

```ts
describe("pollOne drainSelfFlag (force-drain producer)", () => {
  it("flags an unreliable-detector source when drainSelfFlag is present", async () => {
    const db = mkDb();
    // A scrape source whose playbook marks the detector unreliable.
    seedScrapeSource(db, "src_unrel", {
      quirk: { changeDetector: "unreliable" },
      lastFetchedAt: new Date().toISOString(), // fresh — only the unreliable rule applies
    });
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_unrel"));
    const res = await pollOne(db, row, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: playbookNotesFor("src_unrel", { changeDetector: "unreliable" }),
      drainSelfFlag: { staleHours: 72 },
    });
    expect(res.changed).toBe(true);
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_unrel"));
    expect(after.changeDetectedAt).not.toBeNull();
  });

  it("does NOT flag an unreliable source when drainSelfFlag is absent (today's behavior)", async () => {
    const db = mkDb();
    seedScrapeSource(db, "src_unrel2", { quirk: { changeDetector: "unreliable" } });
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_unrel2"));
    const res = await pollOne(db, row, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: playbookNotesFor("src_unrel2", { changeDetector: "unreliable" }),
    });
    expect(res.changed).toBe(false);
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_unrel2"));
    expect(after.changeDetectedAt).toBeNull();
  });

  it("flags a stale source even with a working detector reporting unchanged", async () => {
    const db = mkDb();
    const old = new Date(Date.now() - 100 * 3600_000).toISOString(); // 100h ago > 72h
    seedScrapeSource(db, "src_stale", {
      quirk: { changeDetector: "body-hash", changeProbeUrl: "https://example.com/p" },
      lastFetchedAt: old,
      // pageContentHash preset so bodyHashCheck reports "unchanged" (mock the fetch to return the same body)
    });
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_stale"));
    const res = await pollOne(db, row, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: playbookNotesFor("src_stale", {
        changeDetector: "body-hash",
        changeProbeUrl: "https://example.com/p",
      }),
      signedFetch: mockUnchangedFetch(), // returns the body whose hash == stored pageContentHash
      drainSelfFlag: { staleHours: 72 },
    });
    expect(res.changed).toBe(true);
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_stale"));
    expect(after.changeDetectedAt).not.toBeNull();
  });

  it("does NOT flag a fresh source with a working detector reporting unchanged", async () => {
    const db = mkDb();
    seedScrapeSource(db, "src_fresh", {
      quirk: { changeDetector: "body-hash", changeProbeUrl: "https://example.com/p" },
      lastFetchedAt: new Date().toISOString(),
    });
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_fresh"));
    const res = await pollOne(db, row, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: playbookNotesFor("src_fresh", {
        changeDetector: "body-hash",
        changeProbeUrl: "https://example.com/p",
      }),
      signedFetch: mockUnchangedFetch(),
      drainSelfFlag: { staleHours: 72 },
    });
    expect(res.changed).toBe(false);
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_fresh"));
    expect(after.changeDetectedAt).toBeNull();
  });
});
```

> NOTE: `seedScrapeSource`, `playbookNotesFor`, `mockUnchangedFetch` are helpers to add to this test file if not already present. `playbookNotesFor(slug, quirk)` returns a JSON string shaped like the playbook notes `loadFetchQuirks` parses — copy the shape from an existing `poll-fetch-change-detectors.test.ts` fixture. `mockUnchangedFetch` returns a `fetch` stub whose response body hashes to the seeded `pageContentHash`. If the existing file already has equivalents, reuse them and delete the duplicates.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/poll-fetch-change-detectors.test.ts`
Expected: FAIL — `drainSelfFlag` is not a recognized option; unreliable/stale sources are not flagged.

- [ ] **Step 3: Add the `isStale` helper and thread the option**

In `workers/api/src/cron/poll-fetch.ts`, add near the top of the scrape/agent section (just above `pollScrapeOrAgentByQuirk`, ~line 492):

```ts
/**
 * Force-drain staleness test (#518 → producer). A source is stale when it has
 * never fetched or its last successful fetch is older than `staleHours`.
 */
function isStale(lastFetchedAt: string | null, now: Date, staleHours: number): boolean {
  if (!lastFetchedAt) return true;
  const t = Date.parse(lastFetchedAt);
  return !Number.isFinite(t) || t < now.getTime() - staleHours * 3600_000;
}
```

Extend the `pollOne` opts type (~line 368-372) to add the option:

```ts
  opts?: {
    changeDetectEnabled?: boolean;
    playbookNotes?: string | null;
    signedFetch?: typeof fetch;
    /**
     * When present, scrape/agent sources self-flag `changeDetectedAt` for the
     * OrgActor drain instead of waiting for the force-drain cron (#518). Absent
     * ⇒ today's behavior (unreliable/absent detector is a no-op).
     */
    drainSelfFlag?: { staleHours: number };
  },
```

In `pollOne`, pass it into `pollScrapeOrAgentByQuirk` (~line 407-414):

```ts
return pollScrapeOrAgentByQuirk(
  db,
  source,
  meta,
  now,
  opts.playbookNotes ?? null,
  opts.signedFetch,
  opts.drainSelfFlag,
);
```

- [ ] **Step 4: Implement the producer inside `pollScrapeOrAgentByQuirk`**

Change the signature (~line 493-500) to accept the option:

```ts
async function pollScrapeOrAgentByQuirk(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  now: Date,
  playbookNotes: string | null,
  signedFetch?: typeof fetch,
  drainSelfFlag?: { staleHours: number },
): Promise<PollResult> {
```

In `persistOutcome` (~line 526-538), fold the stale rule into the flag decision:

```ts
const persistOutcome = async (
  metaUpdates: Partial<SourceMetadata>,
  status: ChangeStatus,
): Promise<boolean> => {
  const changed = status === "changed" || status === "unknown";
  const staleFlag =
    drainSelfFlag != null && isStale(source.lastFetchedAt, now, drainSelfFlag.staleHours);
  const flagged = changed || staleFlag;
  const updates: Record<string, unknown> = { lastPolledAt: nowIso };
  if (Object.keys(metaUpdates).length > 0) {
    updates.metadata = JSON.stringify({ ...meta, ...metaUpdates });
  }
  if (flagged) updates.changeDetectedAt = nowIso;
  await db.update(sources).set(updates).where(eq(sources.id, source.id));
  return flagged;
};
```

Replace the unreliable/absent branch (~line 540-544) so it self-flags:

```ts
if (!quirk || quirk.changeDetector === "unreliable") {
  // Force-drain producer (#518): flag when the detector can never self-signal
  // (unreliable) or the source is stale. Absent quirk only flags on staleness.
  const unreliable = quirk?.changeDetector === "unreliable";
  const flagged =
    drainSelfFlag != null &&
    (unreliable || isStale(source.lastFetchedAt, now, drainSelfFlag.staleHours));
  const updates: Record<string, unknown> = { lastPolledAt: nowIso };
  if (flagged) updates.changeDetectedAt = nowIso;
  await db.update(sources).set(updates).where(eq(sources.id, source.id));
  logOutcome(quirk?.changeDetector ?? "none", flagged ? "changed" : "skipped");
  return { source, changed: flagged };
}
```

- [ ] **Step 5: Compute `drainSelfFlag` in the poll workflow**

In `workers/api/src/workflows/poll-and-fetch.ts`, add the imports (top of file, alongside the other `@releases/lib` imports):

```ts
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
```

Add to `PollAndFetchWorkflowEnv` (inside the object literal, ~line 97 before `_drizzleOverride`):

```ts
    /** Cloudflare Flagship binding (for org-drain-actor-enabled). */
    FLAGS?: FlagshipBinding;
    /** Kill-switch var fallback for org-drain-actor-enabled. */
    ORG_DRAIN_ACTOR_ENABLED?: string;
    /** Staleness horizon for the poll-path self-flag producer (default 72h). */
    FORCE_DRAIN_STALE_HOURS?: string;
```

In the `poll-head-check` step (~line 532-542), compute the option and pass it:

```ts
const drainActorOn = await flag(env.FLAGS, env.ORG_DRAIN_ACTOR_ENABLED, FLAGS.orgDrainActorEnabled);
const staleHours = Number(env.FORCE_DRAIN_STALE_HOURS ?? 72);
const drainSelfFlag =
  drainActorOn && (source.type === "scrape" || source.type === "agent")
    ? { staleHours: Number.isFinite(staleHours) && staleHours > 0 ? staleHours : 72 }
    : undefined;
return await pollOne(db, source, now, {
  changeDetectEnabled,
  playbookNotes: source.orgId ? (notesByOrg.get(source.orgId) ?? null) : null,
  signedFetch: await makeBotFetch(env),
  drainSelfFlag,
});
```

> The inline `pollAndFetch` fallback (`poll-fetch.ts:157`) intentionally does NOT pass `drainSelfFlag` — it runs only when the actor bindings are absent (local dev), where the crons drive and the flag is off. Leave it unchanged.

- [ ] **Step 6: Run tests + full check**

Run: `bun test workers/api/test/poll-fetch-change-detectors.test.ts && bun run check`
Expected: PASS; check clean.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts workers/api/src/workflows/poll-and-fetch.ts workers/api/test/poll-fetch-change-detectors.test.ts
git -c user.email=zach@buildinternet.com commit -m "feat(poll): self-flag stranded scrape/agent sources (retires force-drain producer)"
```

---

### Task 3: `OrgActor` DO — per-org drain (retires #482 consumer)

**Files:**

- Create: `workers/api/src/org-actor.ts`
- Test: `workers/api/test/org-actor.test.ts`

**Interfaces:**

- Produces:
  - `class OrgActor extends DurableObject<OrgActorEnv>`
  - `OrgActor.ensureDrainScheduled(orgId: string): Promise<void>` — idempotent; stores `orgId` and arms the alarm (jittered) if none is set. Consumed by Task 5.
  - `OrgActor.alarm(): Promise<void>` — queries the org's flagged candidates and dispatches one `/update`.
  - `interface OrgActorEnv { DB: D1Database; DISCOVERY_WORKER?: { fetch: (i: RequestInfo | URL, init?: RequestInit) => Promise<Response> }; RELEASES_API_KEY?: { get(): Promise<string> }; RELEASED_API_KEY?: { get(): Promise<string> }; _drizzleOverride?: any }`
  - `const ORG_DRAIN_CHUNK = 20` (mirrors discovery `MAX_UPDATE_SOURCES`).

- [ ] **Step 1: Write the failing tests**

Create `workers/api/test/org-actor.test.ts` (mirror the `source-actor.test.ts` fake-DO harness):

```ts
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

function mkActor(db: Db, updateImpl?: (body: any) => Response) {
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

  it("does not throw when /update returns an error (spend cap / lock)", async () => {
    const db = mkDb();
    seedFlaggedScrape(db, "src_a");
    const h = mkActor(
      db,
      () =>
        new Response(JSON.stringify({ error: "Daily global spend cap reached" }), { status: 429 }),
    );
    await h.actor.ensureDrainScheduled("org_x");
    await h.actor.alarm(); // must not throw
    expect(h.dispatched.length).toBe(1);
    expect(h.alarmAt()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/org-actor.test.ts`
Expected: FAIL — `../src/org-actor.js` does not exist.

- [ ] **Step 3: Implement the `OrgActor`**

Create `workers/api/src/org-actor.ts`:

```ts
/**
 * OrgActor — one Durable Object per org (`ORG_ACTOR.getByName(orgId)`) that owns
 * the scrape/agent drain: it dispatches a single managed-agent `/update` session
 * for its org's flagged sources. Replaces the daily scrape-agent-sweep cron
 * (#482); the force-drain producer (#518) moves into the SourceActor poll path.
 *
 * Armed by the SourceActor alarm via `ensureDrainScheduled(orgId)` when a source
 * is flagged (`changeDetectedAt` set). The SourceActor's own recurring alarm is
 * the at-least-once safety net — if the arming RPC is dropped, the next alarm
 * re-notifies (the flag persists until the source drains).
 *
 * No in-app budget: the discovery `/update` endpoint already enforces the per-org
 * ($2/day) + global ($15/day) dollar spend cap (checkSpendCap, #1055) and the
 * per-source scrape lock (#1815) before minting a session, so this actor just
 * dispatches. A rejected /update (cap hit / locked) is logged and dropped; the
 * source stays flagged and re-drains on a later SourceActor notify.
 */

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { seedJitterMs } from "./lib/source-actor-seed.js";

const ORG_ID_KEY = "orgId";

/** Max sources per /update call — mirrors discovery's MAX_UPDATE_SOURCES. */
export const ORG_DRAIN_CHUNK = 20;

export interface OrgActorEnv {
  DB: D1Database;
  DISCOVERY_WORKER?: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  RELEASES_API_KEY?: { get(): Promise<string> };
  RELEASED_API_KEY?: { get(): Promise<string> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _drizzleOverride?: any;
}

interface DrainCandidate {
  id: string;
  orgName: string;
}

export class OrgActor extends DurableObject<OrgActorEnv> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db(): any {
    return this.env._drizzleOverride ?? drizzle(this.env.DB);
  }

  /** Idempotent: store the org id and arm the drain alarm (jittered) if unset. */
  async ensureDrainScheduled(orgId: string): Promise<void> {
    await this.ctx.storage.put(ORG_ID_KEY, orgId);
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null) return;
    await this.ctx.storage.setAlarm(Date.now() + seedJitterMs(orgId));
  }

  async alarm(): Promise<void> {
    const orgId = await this.ctx.storage.get<string>(ORG_ID_KEY);
    // Always clear the alarm; re-arming is driven by the SourceActor notify.
    await this.ctx.storage.deleteAlarm();
    if (!orgId) {
      logEvent("error", { component: "org-actor", event: "alarm-missing-org-id" });
      return;
    }

    const candidates = await this.queryFlagged(orgId);
    if (candidates.length === 0) {
      logEvent("info", { component: "org-actor", event: "drain-skipped", orgId });
      return;
    }

    const disc = this.env.DISCOVERY_WORKER;
    if (!disc) {
      logEvent("warn", { component: "org-actor", event: "discovery-binding-missing", orgId });
      return;
    }

    const apiKey =
      (await this.env.RELEASES_API_KEY?.get().catch(() => null)) ??
      (await this.env.RELEASED_API_KEY?.get().catch(() => null));
    if (!apiKey) {
      logEvent("warn", { component: "org-actor", event: "api-key-missing", orgId });
      return;
    }

    const sourceIdentifiers = candidates.map((c) => c.id);
    const company = candidates[0].orgName;
    try {
      const res = await disc.fetch("https://discovery/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          company,
          sourceIdentifiers,
          orgId,
          correlationId: `org-actor:${orgId}`,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logEvent("warn", {
          component: "org-actor",
          event: "drain-failed",
          orgId,
          status: res.status,
          detail: body.slice(0, 200),
          sourceCount: sourceIdentifiers.length,
        });
        return;
      }
      const { sessionId } = (await res.json().catch(() => ({}))) as { sessionId?: string };
      logEvent("info", {
        component: "org-actor",
        event: "drain-dispatched",
        orgId,
        sessionId: sessionId ?? null,
        sourceCount: sourceIdentifiers.length,
      });
    } catch (err) {
      logEvent("error", {
        component: "org-actor",
        event: "drain-error",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Flagged scrape/agent candidates for this org — the scrape-agent-sweep filter
   * (queryCandidates) scoped to one org: not paused/hidden/firecrawl/feed, org
   * not fetch_paused, `changeDetectedAt` set, most-stale first, capped at one
   * session's worth.
   */
  private async queryFlagged(orgId: string): Promise<DrainCandidate[]> {
    const rows = await this.db()
      .select({ id: sources.id, orgName: organizations.name, orgPaused: organizations.fetchPaused })
      .from(sources)
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .where(
        and(
          eq(sources.orgId, orgId),
          inArray(sources.type, ["scrape", "agent"]),
          ne(sources.fetchPriority, "paused"),
          isNotNull(sources.changeDetectedAt),
          sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR ${sources.metadata} IS NULL)`,
          sql`(json_extract(${sources.metadata}, '$.firecrawl.enabled') IS NULL OR json_extract(${sources.metadata}, '$.firecrawl.enabled') != 1)`,
          or(eq(sources.isHidden, false), isNull(sources.isHidden)),
          or(eq(organizations.fetchPaused, false), isNull(organizations.fetchPaused)),
        ),
      )
      .orderBy(asc(sources.lastFetchedAt), asc(sources.changeDetectedAt))
      .limit(ORG_DRAIN_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ id: r.id, orgName: r.orgName }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test workers/api/test/org-actor.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/org-actor.ts workers/api/test/org-actor.test.ts
git -c user.email=zach@buildinternet.com commit -m "feat(org-actor): per-org drain DO dispatching one /update session"
```

---

### Task 4: Register the `OrgActor` binding + migration

**Files:**

- Modify: `workers/api/src/index.ts` (export ~line 63; `Env` binding ~line 94)
- Modify: `workers/api/wrangler.jsonc` (top-level `durable_objects.bindings` ~330 + `migrations` ~338; `[env.staging]` `durable_objects.bindings` ~830 + `migrations` ~836)

**Interfaces:**

- Consumes: `OrgActor` (Task 3).
- Produces: `env.ORG_ACTOR: DurableObjectNamespace<OrgActor>` binding available to the worker + `SourceActor` (Task 5).

- [ ] **Step 1: Export the class + add the binding type**

In `workers/api/src/index.ts`, after the `SourceActor` export (~line 63):

```ts
export { OrgActor } from "./org-actor.js";
```

In the `Env["Bindings"]` interface, after the `SOURCE_ACTOR` binding (~line 94):

```ts
    // Per-org scrape/agent drain actor (#1777 cron-absorption slice). When bound,
    // a flagged source's SourceActor arms this DO, which dispatches one /update
    // session for the org. Absent ⇒ the scrape-agent + force-drain crons drive.
    ORG_ACTOR?: DurableObjectNamespace<import("./org-actor.js").OrgActor>;
    /** Kill-switch var fallback for org-drain-actor-enabled (Flagship is source of truth). */
    ORG_DRAIN_ACTOR_ENABLED?: string;
```

- [ ] **Step 2: Register the DO + migration in wrangler (top-level)**

In `workers/api/wrangler.jsonc`, add to `durable_objects.bindings` (after the `SourceActor` line ~332):

```jsonc
      { "class_name": "OrgActor", "name": "ORG_ACTOR" },
```

Add to `migrations` (after the `v3` line ~338):

```jsonc
    { "new_classes": ["OrgActor"], "tag": "v4" },
```

- [ ] **Step 3: Register the DO + migration in wrangler (`[env.staging]`)**

Add the identical binding line to the staging `durable_objects.bindings` (after ~830) and the identical `v4` migration line to the staging `migrations` (after ~836).

- [ ] **Step 4: Typecheck**

Run: `bun run check`
Expected: clean (the class is exported, binding typed, wrangler JSON valid).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/index.ts workers/api/wrangler.jsonc
git -c user.email=zach@buildinternet.com commit -m "feat(org-actor): register OrgActor DO binding + v4 migration"
```

---

### Task 5: `SourceActor` → `OrgActor` notify

**Files:**

- Modify: `workers/api/src/source-actor.ts` (`SourceActorEnv` ~98-104; `alarm()` after the `if (!row)` block ~222)
- Test: `workers/api/test/source-actor.test.ts` (harness ~91-102; add notify cases)

**Interfaces:**

- Consumes: `env.ORG_ACTOR` (Task 4), `FLAGS.orgDrainActorEnabled` (Task 1), `OrgActor.ensureDrainScheduled` (Task 3).
- Produces: on each alarm, a flagged scrape/agent source (with `orgId`) calls `env.ORG_ACTOR.getByName(orgId).ensureDrainScheduled(orgId)` when the flag is on.

- [ ] **Step 1: Write the failing tests**

Extend the `mkActor` harness in `workers/api/test/source-actor.test.ts` to accept an `ORG_ACTOR` fake + flag var, then add a `describe`:

```ts
// In mkActor's env, add (guarded by an opts field so existing tests are unaffected):
//   FLAGS: undefined,
//   ORG_DRAIN_ACTOR_ENABLED: opts.orgDrainOn ? "true" : undefined,
//   ORG_ACTOR: opts.orgActorCalls
//     ? { getByName: (name: string) => ({ ensureDrainScheduled: async (id: string) => { opts.orgActorCalls!.push({ name, id }); } }) }
//     : undefined,
// and add `orgDrainOn?: boolean; orgActorCalls?: Array<{ name: string; id: string }>` to the opts type.

describe("SourceActor → OrgActor notify", () => {
  it("arms the OrgActor when a flagged scrape source alarms and the flag is on", async () => {
    const db = mkDb();
    seedScrapeFlagged(db, "src_s"); // type scrape, changeDetectedAt set, orgId org_x
    const calls: Array<{ name: string; id: string }> = [];
    const h = mkActor(db, { orgDrainOn: true, orgActorCalls: calls });
    await h.actor.ensureScheduled("src_s");
    await h.actor.alarm();
    expect(calls).toEqual([{ name: "org_x", id: "org_x" }]);
  });

  it("does NOT arm the OrgActor when the flag is off", async () => {
    const db = mkDb();
    seedScrapeFlagged(db, "src_s2");
    const calls: Array<{ name: string; id: string }> = [];
    const h = mkActor(db, { orgDrainOn: false, orgActorCalls: calls });
    await h.actor.ensureScheduled("src_s2");
    await h.actor.alarm();
    expect(calls).toEqual([]);
  });

  it("does NOT arm the OrgActor for an unflagged source", async () => {
    const db = mkDb();
    seedScrapeFlagged(db, "src_s3", { changeDetectedAt: null });
    const calls: Array<{ name: string; id: string }> = [];
    const h = mkActor(db, { orgDrainOn: true, orgActorCalls: calls });
    await h.actor.ensureScheduled("src_s3");
    await h.actor.alarm();
    expect(calls).toEqual([]);
  });
});
```

> Add a `seedScrapeFlagged(db, id, over?)` helper to the test file: inserts a `type: "scrape"` source in `org_x` with `changeDetectedAt` set (or `null` via override) and no feedUrl.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/source-actor.test.ts`
Expected: FAIL — no notify happens (method not implemented / env fields absent).

- [ ] **Step 3: Extend `SourceActorEnv`**

In `workers/api/src/source-actor.ts`, add the import:

```ts
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
```

Extend `SourceActorEnv` (~98-104):

```ts
export interface SourceActorEnv {
  DB: D1Database;
  POLL_AND_FETCH_WORKFLOW?: Workflow;
  /** Per-org drain actor — armed when a scrape/agent source is flagged (#1777). */
  ORG_ACTOR?: DurableObjectNamespace<import("./org-actor.js").OrgActor>;
  /** Cloudflare Flagship binding (org-drain-actor-enabled). */
  FLAGS?: FlagshipBinding;
  /** Kill-switch var fallback for org-drain-actor-enabled. */
  ORG_DRAIN_ACTOR_ENABLED?: string;
  /** Test seam: inject a drizzle handle so unit tests skip a real D1 binding. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _drizzleOverride?: any;
}
```

- [ ] **Step 4: Notify from `alarm()`**

In `alarm()`, immediately after the `if (!row) { ... }` deletion block (~line 222) and before `const now = Date.now();`, add:

```ts
await this.maybeNotifyOrgDrain(row);
```

Add the private helper (near the other internals):

```ts
  /**
   * Arm this source's OrgActor when the source is a flagged scrape/agent source
   * (retires the scrape-agent-sweep trigger). Best-effort — never blocks or fails
   * the alarm. The recurring alarm re-notifies until the flag clears (the source
   * drains), giving at-least-once delivery without a markers table.
   */
  private async maybeNotifyOrgDrain(row: Source): Promise<void> {
    if (row.type !== "scrape" && row.type !== "agent") return;
    if (!row.changeDetectedAt || !row.orgId) return;
    const ns = this.env.ORG_ACTOR;
    if (!ns) return;
    const on = await flag(
      this.env.FLAGS,
      this.env.ORG_DRAIN_ACTOR_ENABLED,
      FLAGS.orgDrainActorEnabled,
    );
    if (!on) return;
    try {
      await ns.getByName(row.orgId).ensureDrainScheduled(row.orgId);
    } catch (err) {
      logEvent("warn", {
        component: "source-actor",
        event: "org-drain-notify-failed",
        sourceId: row.id,
        orgId: row.orgId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 5: Wire the binding into the DO env at the worker level**

The `SourceActor` DO receives the worker env; the `ORG_ACTOR`, `FLAGS`, and `ORG_DRAIN_ACTOR_ENABLED` bindings/vars are already declared on the worker `Env` (Task 4 added `ORG_ACTOR` + `ORG_DRAIN_ACTOR_ENABLED`; `FLAGS` already exists). No extra wiring needed — confirm `FLAGS` is present on the worker `Env` (`workers/api/src/index.ts`, search `FLAGS`). If absent, add `FLAGS?: FlagshipBinding;`.

- [ ] **Step 6: Run tests + full check**

Run: `bun test workers/api/test/source-actor.test.ts && bun run check`
Expected: PASS; check clean. (Existing SourceActor tests still pass — the harness change is additive and defaults the flag off.)

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/source-actor.ts workers/api/test/source-actor.test.ts
git -c user.email=zach@buildinternet.com commit -m "feat(source-actor): arm OrgActor drain for flagged scrape/agent sources"
```

---

### Task 6: Supersede the crons when the flag is on

**Files:**

- Modify: `workers/api/src/cron/scrape-agent-sweep.ts` (`SweepEnv` ~233-252; top of `scrapeAgentSweep` ~271-279)
- Modify: `workers/api/src/cron/force-drain-sweep.ts` (`ForceDrainEnv` ~37-45; top of `forceDrainSweep` ~134-142)
- Modify: `workers/api/src/index.ts` (`scheduled()` `0 1 * * *` branch ~1235; `0 4 * * *` branch ~1125)
- Test: `workers/api/test/scrape-agent-sweep.test.ts`, `workers/api/test/force-drain-sweep.test.ts` (add supersede cases)

**Interfaces:**

- Consumes: `FLAGS.orgDrainActorEnabled` (Task 1).
- Produces: both cron functions early-return when `supersededByActor === true`; `scheduled()` skips the workflow/inline dispatch when the flag is on.

- [ ] **Step 1: Write the failing tests**

Add to `workers/api/test/scrape-agent-sweep.test.ts`:

```ts
it("early-returns without querying when superseded by the OrgActor", async () => {
  const db = mkDb(); // reuse the file's helper
  seedFlaggedSource(db, "src_x"); // would normally be a candidate
  let dispatched = 0;
  await scrapeAgentSweep({
    DB: {} as D1Database,
    _drizzleOverride: db,
    SCRAPE_AGENT_CRON_ENABLED: "true",
    supersededByActor: true,
    DISCOVERY_WORKER: {
      fetch: async () => {
        dispatched++;
        return new Response("{}");
      },
    } as any,
    RELEASES_API_KEY: "k",
  } as any);
  expect(dispatched).toBe(0);
});
```

Add to `workers/api/test/force-drain-sweep.test.ts`:

```ts
it("early-returns without flagging when superseded by the OrgActor", async () => {
  const db = mkDb();
  seedStrandedSource(db, "src_y"); // unreliable/stale, unflagged
  await forceDrainSweep({
    DB: {} as D1Database,
    _drizzleOverride: db,
    FORCE_DRAIN_CRON_ENABLED: "true",
    supersededByActor: true,
  } as any);
  const [row] = await db.select().from(sources).where(eq(sources.id, "src_y"));
  expect(row.changeDetectedAt).toBeNull(); // not flagged — the actor path owns this
});
```

> Reuse each file's existing `mkDb`/seed helpers; add `seedFlaggedSource` / `seedStrandedSource` if not present (a scrape source with `changeDetectedAt` set / a stale-or-unreliable unflagged scrape source).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/scrape-agent-sweep.test.ts workers/api/test/force-drain-sweep.test.ts`
Expected: FAIL — `supersededByActor` is ignored; the sweeps still run.

- [ ] **Step 3: Add the guard to `scrapeAgentSweep`**

In `workers/api/src/cron/scrape-agent-sweep.ts`, add to `SweepEnv` (~233):

```ts
  /** When true, the OrgActor drain owns this work — skip the sweep (#1777). */
  supersededByActor?: boolean;
```

At the very top of `scrapeAgentSweep` (after the `CRON_ENABLED` / `SCRAPE_AGENT_CRON_ENABLED` guards, ~279):

```ts
if (env.supersededByActor) {
  logEvent("info", { component: "scrape-agent-cron", event: "superseded-by-org-drain-actor" });
  return;
}
```

- [ ] **Step 4: Add the guard to `forceDrainSweep`**

In `workers/api/src/cron/force-drain-sweep.ts`, add to `ForceDrainEnv` (~37):

```ts
  /** When true, the SourceActor poll path self-flags — skip the producer (#1777). */
  supersededByActor?: boolean;
```

At the top of `forceDrainSweep` (after the existing `CRON_ENABLED` / `FORCE_DRAIN_CRON_ENABLED` guards, ~142):

```ts
if (env.supersededByActor) {
  logEvent("info", { component: "force-drain-cron", event: "superseded-by-org-drain-actor" });
  return;
}
```

- [ ] **Step 5: Gate the dispatch in `scheduled()`**

In `workers/api/src/index.ts`:

For the `0 1 * * *` branch (~1235), immediately after `if (event.cron === "0 1 * * *") {`:

```ts
if (await flag(env.FLAGS, env.ORG_DRAIN_ACTOR_ENABLED, FLAGS.orgDrainActorEnabled)) {
  logEvent("info", { component: "scrape-agent-cron", event: "superseded-by-org-drain-actor" });
  return;
}
```

For the `0 4 * * *` branch (~1125), compute the flag once at the branch top and wrap ONLY the `forceDrainSweep` dispatch (keep `sendStalenessDigest` unconditional):

```ts
if (event.cron === "0 4 * * *") {
  const drainActorOn = await flag(
    env.FLAGS,
    env.ORG_DRAIN_ACTOR_ENABLED,
    FLAGS.orgDrainActorEnabled,
  );
  if (!drainActorOn) {
    ctx.waitUntil(
      loggedDispatch(
        "force-drain-cron",
        forceDrainSweep({
          DB: env.DB,
          CRON_ENABLED: env.CRON_ENABLED,
          FORCE_DRAIN_CRON_ENABLED: env.FORCE_DRAIN_CRON_ENABLED,
          FORCE_DRAIN_STALE_HOURS: env.FORCE_DRAIN_STALE_HOURS,
          FORCE_SWEEP_MAX_SESSIONS: env.FORCE_SWEEP_MAX_SESSIONS,
        }),
        alertEnv,
      ),
    );
  } else {
    logEvent("info", { component: "force-drain-cron", event: "superseded-by-org-drain-actor" });
  }
  // Source staleness digest (#1528) — runs regardless of the drain path.
  ctx.waitUntil(
    loggedDispatch(
      "staleness-digest-cron",
      sendStalenessDigest({
        /* ...unchanged fields... */
      }),
      alertEnv,
    ),
  );
  return;
}
```

> Keep the existing `sendStalenessDigest({...})` argument object exactly as it is today — only the `forceDrainSweep` call moves inside the `if (!drainActorOn)`.

- [ ] **Step 6: Run tests + full check**

Run: `bun test workers/api/test/scrape-agent-sweep.test.ts workers/api/test/force-drain-sweep.test.ts && bun run check`
Expected: PASS; check clean.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/cron/scrape-agent-sweep.ts workers/api/src/cron/force-drain-sweep.ts workers/api/src/index.ts workers/api/test/scrape-agent-sweep.test.ts workers/api/test/force-drain-sweep.test.ts
git -c user.email=zach@buildinternet.com commit -m "feat(cron): supersede scrape-agent + force-drain sweeps under org-drain flag"
```

---

### Task 7: Documentation

**Files:**

- Modify: `docs/architecture/remote-mode.md` (cron/workflow ingest section)
- Modify: `AGENTS.md` (the workflows/cron conventions bullet)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the actor-drain path in remote-mode.md**

Add a subsection under the cron/ingest area describing: the `SourceActor` poll path self-flags stranded scrape/agent sources (unreliable detector or stale > `FORCE_DRAIN_STALE_HOURS`); the `SourceActor` alarm arms `OrgActor(orgId)`; the `OrgActor` dispatches one `/update` per org; spend is capped by the existing `checkSpendCap` and dedup by the #1815 scrape lock; the whole path is gated by `org-drain-actor-enabled` (OFF ⇒ the `force-drain-sweep` #518 + `scrape-agent-sweep` #482 crons run as before). Note rollback = flip the flag OFF.

- [ ] **Step 2: Update the AGENTS.md conventions bullet**

Add one line to the ingest/cron conventions noting that the scrape/agent drain moves to the `OrgActor` DO behind `org-drain-actor-enabled`, with the two crons as the flag-off fallback, pointing at the spec.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git -c user.email=zach@buildinternet.com commit -m "docs: describe OrgActor scrape/agent drain path + flag"
```

---

## Post-merge (manual, not code)

1. Create the `org-drain-actor-enabled` key (default OFF) in BOTH Flagship apps: `releases-platform` and `releases-platform-staging`.
2. Merge → auto-deploy (adds the dormant `OrgActor` DO + `v4` migration; flag off ⇒ no behavior change).
3. Flip `org-drain-actor-enabled` ON in `releases-platform`. Watch Axiom `releases-cloudflare-logs`:
   - `source-actor` `org-drain-notify-failed` should be absent;
   - `org-actor` `drain-dispatched` volume ≈ prior `scrape-agent-cron` session volume;
   - `scrape-agent-cron` / `force-drain-cron` emit `superseded-by-org-drain-actor` (not `done`);
   - no `drain-error`; `/update` spend-cap/lock rejections show as `org-actor drain-failed` (benign).
4. Rollback if needed: flip the flag OFF — the crons resume on their next tick.

## Self-Review

- **Spec coverage:** Producer/self-flag (spec §Design.1) → Task 2. OrgActor consumer (§Design.2) → Task 3 + Task 4. Notify + at-least-once safety net (§Design.1) → Task 5. Rate smear (§Design.3) → `seedJitterMs` in Task 3's `ensureDrainScheduled`. Budget-free rationale (§Why no budget layer) → realized by leaning on the existing `checkSpendCap` at `/update` (documented in Task 3 header + Task 7). Kill switch + cron supersede + double-dispatch guard (§Migration) → Task 1 flag + Task 6 gates + the discovery `/update` scrape lock (#1815, unchanged). Observability (§Observability) → `logEvent` calls in Tasks 3/5/6. Testing (§Testing) → Tasks 2/3/5/6 test steps.
- **Deviation from spec (intentional, better):** the spec assumed the OrgActor would acquire scrape locks and might need its own budget; the code review found `/update` already acquires per-source locks (`tryAcquireSourceLocks`) AND enforces a per-org+global dollar spend cap (`checkSpendCap`), so the OrgActor just dispatches. This makes the actor simpler than the spec drew and strengthens the budget-free decision. No task needs the removed complexity.
- **Placeholder scan:** none — every code step shows real code; test-helper stubs (`seedScrapeSource`, `mockUnchangedFetch`, etc.) are explicitly flagged to reuse existing fixtures or add with a stated shape.
- **Type consistency:** `drainSelfFlag: { staleHours: number }` is the same shape in `pollOne` opts (Task 2), `pollScrapeOrAgentByQuirk` (Task 2), and the workflow caller (Task 2). `ensureDrainScheduled(orgId)` signature matches across `OrgActor` (Task 3), the `SourceActor` call (Task 5), and the test fakes. `supersededByActor?: boolean` matches across both cron envs and `scheduled()` (Task 6). Binding name `ORG_ACTOR` matches `Env` (Task 4), `SourceActorEnv` (Task 5), and wrangler (Task 4).
