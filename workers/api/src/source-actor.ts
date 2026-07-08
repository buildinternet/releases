/**
 * SourceActor — one Durable Object per source (`SOURCE_ACTOR.getByName(sourceId)`),
 * owning that source's fetch lifecycle: its own alarm-driven fetch timer, tier
 * cadence (normal 4h / low 24h), smart-fetch backoff, and single-threaded
 * serialization. Each source schedules itself instead of being swept up by the
 * hourly poll cron + due-query + fan-out + FNV-1a jitter smear. See #1776 and
 * docs/architecture/durable-objects-exploration.md §SourceActor.
 *
 * Migration seam (deliberate): the DO owns the **timer + mutex only**. The proven
 * `PollAndFetchWorkflow` still does the actual fetch/parse/embed/ingest — the
 * alarm just `create()`s an instance. The ingest pipeline is untouched.
 *
 * Outcome feedback without a callback: the workflow already writes
 * `last_polled_at` / `next_fetch_after` / `consecutive_no_change` to D1, so this
 * actor never recomputes backoff. Each alarm re-reads the D1 row and derives the
 * next-due time from `computeFetchState()` (the same helper the dev fetch-plan
 * panel uses). Backoff is honored on the next tick; a backed-off source simply
 * reschedules forward (alarms are ~free). This makes the alarm idempotent
 * (double-fires re-read D1, which the workflow advances) with no extra wiring.
 *
 * DO storage holds only derived, bounded, rehydratable state (re-read from D1 on
 * every alarm, so eviction is free). D1 stays the system of record.
 */

import { DurableObject } from "cloudflare:workers";
import { createDb } from "./db.js";
import { eq, sql } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { describeFetchPlan, computeFetchState } from "@releases/adapters/fetch-plan";
import { logEvent } from "@releases/lib/log-event";
import { seedJitterMs } from "./lib/source-actor-seed.js";
import { notifyOrgDrain } from "./lib/org-drain-notify.js";

/**
 * In-flight guard window. A fired workflow (poll + fetch + content + embed +
 * changelog, each with retries) completes well within this; until it elapses a
 * re-fire is suppressed so a spurious double-alarm can't spawn a second instance.
 * Longer than the worst-case ingest run, shorter than the `normal` tier interval.
 */
const SAFETY_WINDOW_MS = 15 * 60 * 1000;

/** Retry alarm after a failed workflow.create — short enough to recover from
 *  transient control-plane errors, far shorter than the tier interval. */
const CREATE_FAILURE_RETRY_MS = 10 * 60 * 1000;

/**
 * Slack on the due-gate: treat a source whose `nextDueAt` is within this of `now`
 * as due (avoids a needless extra wake when the alarm fires a hair early).
 */
const DUE_SLACK_MS = 30 * 1000;

const STATE_KEY = "state";
const SOURCE_ID_KEY = "sourceId";

/**
 * Per-source MA-delegation lock (#1780 Box 1 / #1814). Replaces the KV
 * `ma:active:src:{id}` lock: the mutex that stops two managed-agent sessions
 * running for the same source at once now lives in this DO's storage instead of
 * the shared `LATEST_CACHE` KV namespace. The discovery worker (cross-script
 * `SOURCE_ACTOR` binding) checks/acquires around minting a session and releases
 * in its completion `finally`, exactly where the KV lock used to sit.
 */
const SCRAPE_LOCK_KEY = "scrapeLock";

/**
 * Lease length, mirroring the KV lock's 15-min `expirationTtl`. DO storage has
 * no native key TTL, so expiry is a stored `expiresAt` enforced lazily on read
 * (a lease past its deadline is treated as absent) — the backstop for a session
 * that dies before its release RPC lands. Must stay far shorter than the 24h
 * force-drain interval so a stale lease always self-clears before force-drain
 * runs (see .context/1780-box1-delegation-serialization-design.md).
 */
const SCRAPE_LOCK_LEASE_MS = 15 * 60 * 1000;

interface ScrapeLock {
  /** The MA sessionId that owns the lease (for conditional release). */
  sessionId: string;
  /** ms epoch after which the lease is stale and treated as absent. */
  expiresAt: number;
}

/** Derived, rehydratable coordination state persisted in DO storage. */
export interface SourceActorState {
  /** Mirrored from D1 `fetch_priority` on each alarm. */
  tier: Source["fetchPriority"];
  /** ISO time of the last successful fetch (mirrored from D1). */
  lastFetchedAt: string | null;
  /** ms epoch of the next scheduled alarm (null ⇒ no reschedule: paused/firecrawl). */
  nextAlarmAt: number | null;
  /** A workflow was fired and is presumed running (cleared once past SAFETY_WINDOW). */
  inFlight: boolean;
  /** ms epoch of the last workflow fire (drives the in-flight guard window). */
  lastFiredAt: number | null;
  /** Backoff snapshot mirrored from D1 for observability + rehydration. */
  backoff: {
    consecutiveNoChange: number;
    consecutiveErrors: number;
    nextFetchAfter: string | null;
  };
}

export interface SourceActorEnv {
  DB: D1Database;
  POLL_AND_FETCH_WORKFLOW?: Workflow;
  /** Per-org drain actor — armed when a scrape/agent source is flagged (#1777). */
  ORG_ACTOR?: DurableObjectNamespace<import("./org-actor.js").OrgActor>;
  /** Test seam: inject a drizzle handle so unit tests skip a real D1 binding. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _drizzleOverride?: any;
}

export class SourceActor extends DurableObject<SourceActorEnv> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db(): any {
    return this.env._drizzleOverride ?? createDb(this.env.DB);
  }

  /**
   * Idempotent bootstrap + heartbeat called by the poll cron for actor-managed
   * due sources. Persists the source identity and seeds the first alarm if none
   * is pending; once scheduled this is a cheap no-op (the alarm self-perpetuates).
   * All due/backoff logic lives in `alarm()`, which re-reads D1 — so the seed
   * alarm only needs to fire "soon" (jittered to spread the cohort-enable herd).
   */
  async ensureScheduled(sourceId: string): Promise<void> {
    await this.ctx.storage.put(SOURCE_ID_KEY, sourceId);
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null) return;
    await this.ctx.storage.setAlarm(Date.now() + seedJitterMs(sourceId));
  }

  /**
   * Re-parenting / tier-change hook (AC stub). A source PATCH that changes
   * product/org/tier calls this so a pause or tier change is honored promptly
   * rather than on the next natural alarm. The full parent-notify protocol (old
   * + new `ProductActor`) is deferred with #1777 — for now we log the signal and
   * pull this source's own alarm in to re-evaluate against fresh D1.
   */
  async onSourceChanged(sourceId: string): Promise<void> {
    await this.ctx.storage.put(SOURCE_ID_KEY, sourceId);
    logEvent("info", {
      component: "source-actor",
      event: "source-changed-reparent-stub",
      sourceId,
    });
    await this.ctx.storage.setAlarm(Date.now() + seedJitterMs(sourceId));
  }

  /** Observability/test accessor for the persisted coordination state. */
  async getState(): Promise<SourceActorState | null> {
    return (await this.ctx.storage.get<SourceActorState>(STATE_KEY)) ?? null;
  }

  /**
   * MA-delegation lock — atomic try-acquire (#1780 Box 1 / #1814).
   *
   * The real per-source mutex: because the DO runs single-threaded, this
   * read-then-write is indivisible, so it does what the KV lock only approximated
   * (its separate get-then-put left a TOCTOU window). Claims the lease for
   * `sessionId` with a fresh 15-min deadline and returns `{ acquired: true }`
   * ONLY when the source was free. When a live lease is already held it does NOT
   * overwrite — it returns `{ acquired: false, sessionId: <current owner> }` so
   * the discovery worker rejects the delegation *before* minting a duplicate
   * session. A lease past its `expiresAt` is treated as free and reclaimed (the
   * lazy-expiry backstop for a session that died before releasing).
   */
  async tryAcquireScrapeLock(
    sourceId: string,
    sessionId: string,
  ): Promise<{ acquired: boolean; sessionId: string }> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<ScrapeLock>(SCRAPE_LOCK_KEY);
    if (existing && existing.expiresAt > now) {
      logEvent("info", {
        component: "source-actor",
        event: "scrape-lock-contended",
        sourceId,
        sessionId,
        owner: existing.sessionId,
      });
      return { acquired: false, sessionId: existing.sessionId };
    }
    await this.ctx.storage.put<ScrapeLock>(SCRAPE_LOCK_KEY, {
      sessionId,
      expiresAt: now + SCRAPE_LOCK_LEASE_MS,
    });
    logEvent("info", {
      component: "source-actor",
      event: "scrape-lock-acquired",
      sourceId,
      sessionId,
    });
    return { acquired: true, sessionId };
  }

  /**
   * MA-delegation lock — conditional release. Clears the lease only when
   * `sessionId` still owns it, so a session whose lease already expired and was
   * re-claimed by a newer owner can't delete the newer lease (the DO-atomic
   * version of the KV "read owner, delete iff mine" release in
   * `managed-agents-session.ts`). No-op when the lease is absent or foreign.
   */
  async releaseScrapeLock(sourceId: string, sessionId: string): Promise<void> {
    const lock = await this.ctx.storage.get<ScrapeLock>(SCRAPE_LOCK_KEY);
    if (lock && lock.sessionId === sessionId) {
      await this.ctx.storage.delete([SCRAPE_LOCK_KEY]);
      logEvent("info", {
        component: "source-actor",
        event: "scrape-lock-released",
        sourceId,
        sessionId,
      });
    }
  }

  async alarm(): Promise<void> {
    const sourceId = await this.ctx.storage.get<string>(SOURCE_ID_KEY);
    if (!sourceId) {
      logEvent("error", { component: "source-actor", event: "alarm-missing-source-id" });
      return;
    }

    const row = await this.loadSource(sourceId);
    if (!row) {
      // Source deleted — tear down (the cron won't re-seed a missing row).
      await this.stop(sourceId, "source-deleted");
      return;
    }

    await this.maybeNotifyOrgDrain(row);

    const now = Date.now();
    const plan = describeFetchPlan(row);
    const state = computeFetchState(row, plan, new Date(now));

    // Org-level fetch pause (mirrors queryDueSources): stop rescheduling. The
    // cron re-seeds via ensureScheduled once the org unpauses and the source is
    // due again.
    if (await this.orgFetchPaused(row)) {
      await this.noReschedule(row);
      return;
    }

    // Paused / firecrawl (webhook-driven): no local cadence ⇒ no reschedule.
    if (state.nextDueAt == null) {
      await this.noReschedule(row);
      return;
    }

    const prev = await this.getState();

    // Effective next-due. `computeFetchState` bases a null `last_polled_at` on
    // `now` (so it'd push a never-polled source out a full tier interval), but
    // the cron's due predicate treats null `last_polled_at` as DUE NOW. Honor
    // that here so a freshly-seeded source fetches on its first alarm — while
    // still respecting a future `next_fetch_after` backoff if one is set.
    const neverPolled = row.lastPolledAt == null;
    const backoffMs = row.nextFetchAfter ? Date.parse(row.nextFetchAfter) : NaN;
    const effectiveDueMs = neverPolled
      ? Number.isFinite(backoffMs)
        ? backoffMs
        : now
      : Date.parse(state.nextDueAt);

    // Not yet due — honors tier cadence + smart-fetch backoff, and makes the
    // alarm idempotent (a double-fire re-reads D1, which the workflow advanced).
    if (Number.isFinite(effectiveDueMs) && effectiveDueMs > now + DUE_SLACK_MS) {
      await this.scheduleAt(row, effectiveDueMs, false, prev?.lastFiredAt ?? null);
      return;
    }

    // In-flight guard: a workflow we fired is presumably still running. Re-check
    // after the safety window rather than spawning a second instance.
    const inFlight =
      prev?.inFlight === true &&
      prev.lastFiredAt != null &&
      now - prev.lastFiredAt < SAFETY_WINDOW_MS;
    if (inFlight) {
      await this.scheduleAt(row, now + SAFETY_WINDOW_MS, true, prev?.lastFiredAt ?? null);
      return;
    }

    // Due — fire the existing ingest workflow (timer/mutex here; ingest there).
    const fired = await this.fireWorkflow(sourceId, now);

    // Schedule the next re-evaluation at one tier interval out. By then the
    // workflow has advanced last_polled_at / next_fetch_after, so the next alarm
    // re-derives the precise next-due time (success cadence or backoff) from D1.
    const intervalMs = (plan.intervalHours ?? 4) * 3_600_000;
    const nextAlarmMs = fired ? now + intervalMs : now + CREATE_FAILURE_RETRY_MS;
    if (!fired) {
      logEvent("info", {
        component: "source-actor",
        event: "create-failure-retry-scheduled",
        sourceId,
        retryMs: CREATE_FAILURE_RETRY_MS,
      });
    }
    await this.scheduleAt(row, nextAlarmMs, fired, fired ? now : (prev?.lastFiredAt ?? null));
  }

  // --- internals -----------------------------------------------------------

  /**
   * Arm this source's OrgActor when the source is a flagged scrape/agent source
   * (retires the scrape-agent-sweep trigger). This is the at-least-once BACKSTOP
   * for the eager notify the poll workflow now fires the instant it sets
   * `changeDetectedAt` (#1946 phase 2): the flag it reads here is from the row as
   * loaded at the top of the alarm, so on the alarm whose own workflow just
   * flagged the source the eager path has already armed the drain; this re-arms on
   * every subsequent alarm while the flag persists (a permanently-stranded source
   * whose eager notify was dropped). Best-effort — never blocks or fails the alarm.
   */
  private async maybeNotifyOrgDrain(row: Source): Promise<void> {
    if (row.type !== "scrape" && row.type !== "agent") return;
    if (!row.changeDetectedAt || !row.orgId) return;
    await notifyOrgDrain(this.env.ORG_ACTOR, row.orgId, "source-actor");
  }

  private async loadSource(sourceId: string): Promise<Source | null> {
    const [row] = await this.db().select().from(sources).where(eq(sources.id, sourceId)).limit(1);
    return (row as Source | undefined) ?? null;
  }

  private async orgFetchPaused(row: Source): Promise<boolean> {
    if (!row.orgId) return false;
    const [org] = await this.db()
      .select({ fetchPaused: organizations.fetchPaused })
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);
    return org?.fetchPaused === true;
  }

  private async fireWorkflow(sourceId: string, nowMs: number): Promise<boolean> {
    const wf = this.env.POLL_AND_FETCH_WORKFLOW;
    if (!wf) {
      // Binding absent ⇒ this actor shouldn't be driving (cohort gating requires
      // the binding present). Defensive: log and let the next alarm retry.
      logEvent("warn", {
        component: "source-actor",
        event: "workflow-binding-missing",
        sourceId,
      });
      return false;
    }
    // Deterministic instance id bucketed by the safety window so a spurious
    // double-fire within the window collides on the id (create throws) instead of
    // spawning a second ingest run. Distinct buckets across real fires.
    const bucket = Math.floor(nowMs / SAFETY_WINDOW_MS);
    try {
      await wf.create({
        id: `source-actor-${sourceId}-${bucket}`,
        params: { sourceId, scheduledTime: nowMs },
      });
      logEvent("info", { component: "source-actor", event: "fired", sourceId });
      return true;
    } catch (err) {
      // A duplicate-id collision (already fired this bucket) is benign.
      logEvent("warn", {
        component: "source-actor",
        event: "workflow-create-failed",
        sourceId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Set the alarm, persist state, and mirror to D1 for the dev fetch-plan panel. */
  private async scheduleAt(
    row: Source,
    alarmAtMs: number,
    inFlight: boolean,
    lastFiredAt: number | null,
  ): Promise<void> {
    await this.ctx.storage.setAlarm(alarmAtMs);
    await this.persistState(row, alarmAtMs, inFlight, lastFiredAt);
    await this.mirrorToD1(row.id, alarmAtMs);
  }

  private async persistState(
    row: Source,
    nextAlarmAt: number | null,
    inFlight: boolean,
    lastFiredAt: number | null = null,
  ): Promise<void> {
    const state: SourceActorState = {
      tier: row.fetchPriority ?? "normal",
      lastFetchedAt: row.lastFetchedAt ?? null,
      nextAlarmAt,
      inFlight,
      lastFiredAt,
      backoff: {
        consecutiveNoChange: row.consecutiveNoChange ?? 0,
        consecutiveErrors: row.consecutiveErrors ?? 0,
        nextFetchAfter: row.nextFetchAfter ?? null,
      },
    };
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /**
   * No-reschedule path (org-paused / source-paused / firecrawl): clear the alarm
   * and persisted timer, and update the D1 mirror to `managed:false` so the dev
   * fetch-plan panel doesn't keep showing a stale `nextAlarmAt`.
   */
  private async noReschedule(row: Source): Promise<void> {
    await this.persistState(row, null, false);
    await this.ctx.storage.deleteAlarm();
    await this.mirrorToD1(row.id, null, false);
  }

  /**
   * Write-through a tiny observability mirror into `metadata.sourceActor` so the
   * dev fetch-plan panel can show whether a source is actor-managed and its exact
   * next alarm. Best-effort: never block or fail scheduling. No new D1 column /
   * migration (the panel's due/backoff math already reads existing columns the
   * ingest path keeps fresh).
   */
  private async mirrorToD1(
    sourceId: string,
    nextAlarmMs: number | null,
    managed = true,
  ): Promise<void> {
    const blob = JSON.stringify({
      nextAlarmAt: nextAlarmMs == null ? null : new Date(nextAlarmMs).toISOString(),
      lastAlarmAt: new Date().toISOString(),
      managed,
    });
    try {
      await this.db().run(
        sql`UPDATE sources SET metadata = json_set(coalesce(metadata, '{}'), '$.sourceActor', json(${blob})) WHERE id = ${sourceId}`,
      );
    } catch (err) {
      logEvent("warn", {
        component: "source-actor",
        event: "mirror-write-failed",
        sourceId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Tear down: clear the alarm + persisted state (source deleted / unmanaged). */
  private async stop(sourceId: string, reason: string): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete([STATE_KEY]);
    // Clear the dev-panel mirror so a handed-back / deleted source no longer
    // shows as actor-managed (no-op UPDATE when the row is already gone).
    await this.mirrorToD1(sourceId, null, false);
    logEvent("info", { component: "source-actor", event: "stopped", sourceId, reason });
  }
}
