/**
 * OrgActor — one Durable Object per org (`ORG_ACTOR.getByName(orgId)`) that owns
 * the scrape/agent drain: it dispatches a single deterministic update run for
 * its org's flagged sources. Replaces the daily scrape-agent-sweep cron (#482);
 * the force-drain producer (#518) moves into the SourceActor poll path.
 *
 * Armed by the SourceActor alarm via `ensureDrainScheduled(orgId)` when a source
 * is flagged (`changeDetectedAt` set). The SourceActor's own recurring alarm is
 * the at-least-once safety net — if the arming RPC is dropped, the next alarm
 * re-notifies (the flag persists until the source drains).
 *
 * Dispatch goes through `startDeterministicUpdate` (#1946) — a direct call into
 * the shared gate that enforces the kill switch, the per-org ($2/day) + global
 * ($15/day) spend cap (checkSpendCap, #1055), and the per-source scrape lock
 * (#1815) before creating a `DeterministicUpdateWorkflow` instance. The old
 * cross-service `POST /update` to the discovery worker is gone. A refused
 * dispatch is logged and dropped; the source stays flagged and re-drains on a
 * later SourceActor notify. A lock refusal (the source's own SourceActor scrape
 * holds the lease) is the expected benign race — logged as `drain-superseded`,
 * not `drain-failed`, since the lock holder drains the source.
 *
 * Drain cooldown (#1862): a successful dispatch stamps `sources.last_drain_at`,
 * and `queryCandidates` excludes sources drained within DRAIN_COOLDOWN_MS. This
 * caps re-drains of a still-flagged source at ~once/day (the old sweep's rhythm)
 * instead of once per 4h poll tick, so a permanently un-fetchable source can't
 * re-bill a no-op update run every cycle.
 */

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { seedJitterMs } from "./lib/source-actor-seed.js";
import { queryCandidates } from "./lib/drain-candidates.js";
import {
  startDeterministicUpdate,
  MAX_UPDATE_SOURCES,
  type UpdateDispatchEnv,
} from "./lib/update-dispatch.js";

const ORG_ID_KEY = "orgId";

/** Max sources per drain dispatch — one workflow batch. */
export const ORG_DRAIN_CHUNK = MAX_UPDATE_SOURCES;

export interface OrgActorEnv extends UpdateDispatchEnv {
  DB: D1Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _drizzleOverride?: any;
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
      logEvent("warn", { component: "org-actor", event: "alarm-missing-org-id" });
      return;
    }

    const { rows } = await queryCandidates(this.db(), { cap: ORG_DRAIN_CHUNK, orgId });
    const candidates = rows.map((r) => ({ id: r.id, orgName: r.orgName }));
    if (candidates.length === 0) {
      logEvent("info", { component: "org-actor", event: "drain-skipped", orgId });
      return;
    }

    const sourceIdentifiers = candidates.map((c) => c.id);
    const company = candidates[0].orgName;
    try {
      const result = await startDeterministicUpdate(this.env, {
        company,
        sourceIdentifiers,
        orgId,
        correlationId: `org-actor:${orgId}`,
      });
      if (!result.ok) {
        // A lock refusal is the per-source dedup scrape lock (#1814) firing:
        // the source's own SourceActor scrape grabbed the lease a beat before
        // this drain dispatched. That's benign — the lock holder drains the
        // source, so our dispatch was redundant, not failed. Classify it as
        // `drain-superseded` (info) rather than `drain-failed` so expected
        // lock contention doesn't pollute the drain-error signal. Every other
        // refusal (spend cap, kill switch, workflow unavailable) is a genuine
        // drop worth a warn.
        const superseded = result.reason === "locked";
        logEvent(superseded ? "info" : "warn", {
          component: "org-actor",
          event: superseded ? "drain-superseded" : "drain-failed",
          orgId,
          reason: result.reason,
          detail: result.message.slice(0, 200),
          sourceCount: sourceIdentifiers.length,
        });
        return;
      }
      logEvent("info", {
        component: "org-actor",
        event: "drain-dispatched",
        orgId,
        sessionId: result.sessionId,
        sourceCount: sourceIdentifiers.length,
      });
      // Stamp the drain cooldown (#1862) for every source in the accepted
      // dispatch. queryCandidates excludes these for DRAIN_COOLDOWN_MS, so a
      // still-flagged source (e.g. one that's permanently un-fetchable) can't
      // re-dispatch a no-op update run on the next SourceActor poll tick.
      // Only stamped on success — a refused dispatch (spend cap / lock / kill
      // switch) leaves last_drain_at untouched so the source re-drains sooner.
      //
      // In its OWN try/catch: the dispatch already succeeded (drain-dispatched
      // logged above), so a D1 write failure here must not fall through to the
      // dispatch catch and be misreported as a `drain-error`. Log it distinctly
      // with the affected source ids so a lost cooldown stamp is unambiguous.
      try {
        await this.db()
          .update(sources)
          .set({ lastDrainAt: new Date().toISOString() })
          .where(inArray(sources.id, sourceIdentifiers));
      } catch (err) {
        logEvent("error", {
          component: "org-actor",
          event: "drain-cooldown-stamp-failed",
          orgId,
          sourceIds: sourceIdentifiers,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      logEvent("error", {
        component: "org-actor",
        event: "drain-error",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
