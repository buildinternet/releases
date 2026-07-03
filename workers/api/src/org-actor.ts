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
 * dispatches. A rejected /update is logged and dropped; the source stays flagged
 * and re-drains on a later SourceActor notify. A 409 (per-source scrape lock held
 * by the source's own SourceActor scrape) is the expected benign race — logged as
 * `drain-superseded`, not `drain-failed`, since the lock holder drains the source.
 *
 * Drain cooldown (#1862): a successful dispatch stamps `sources.last_drain_at`,
 * and `queryCandidates` excludes sources drained within DRAIN_COOLDOWN_MS. This
 * caps re-drains of a still-flagged source at ~once/day (the old sweep's rhythm)
 * instead of once per 4h poll tick, so a permanently un-fetchable source can't
 * re-bill a no-op Haiku `/update` every cycle.
 */

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { seedJitterMs } from "./lib/source-actor-seed.js";
import { queryCandidates } from "./cron/scrape-agent-sweep.js";

const ORG_ID_KEY = "orgId";

/** Max sources per /update call — mirrors discovery's MAX_UPDATE_SOURCES. */
export const ORG_DRAIN_CHUNK = 20;

/**
 * Bounded timeout on the `/update` dispatch so a slow/hung discovery worker
 * can't stall the alarm handler. On timeout the fetch rejects, the catch logs
 * `drain-error`, and the source stays flagged to re-drain on the next notify.
 */
const ORG_DRAIN_DISPATCH_TIMEOUT_MS = 30_000;

export interface OrgActorEnv {
  DB: D1Database;
  DISCOVERY_WORKER?: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  RELEASES_API_KEY?: { get(): Promise<string> };
  RELEASED_API_KEY?: { get(): Promise<string> };
  /** Cloudflare Flagship binding — the org-drain kill switch is re-checked at dispatch. */
  FLAGS?: FlagshipBinding;
  /** Kill-switch var fallback for org-drain-actor-enabled. */
  ORG_DRAIN_ACTOR_ENABLED?: string;
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

    // Re-check the kill switch at execution time: an OrgActor armed while the
    // flag was on must NOT dispatch a billable /update if the flag was flipped
    // off before this alarm fired (the alarm is already cleared above, so a
    // disabled actor simply goes dormant until the SourceActor re-arms it).
    const enabled = await flag(
      this.env.FLAGS,
      this.env.ORG_DRAIN_ACTOR_ENABLED,
      FLAGS.orgDrainActorEnabled,
    );
    if (!enabled) {
      logEvent("info", { component: "org-actor", event: "drain-disabled", orgId });
      return;
    }

    const { rows } = await queryCandidates(this.db(), { cap: ORG_DRAIN_CHUNK, orgId });
    const candidates = rows.map((r) => ({ id: r.id, orgName: r.orgName }));
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
        // Fail fast if discovery is slow/hung — AbortSignal.timeout self-clears,
        // and a rejection lands in the catch below (source stays flagged).
        signal: AbortSignal.timeout(ORG_DRAIN_DISPATCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // A 409 from /update is the per-source dedup scrape lock (#1814) firing:
        // the source's own SourceActor scrape grabbed the lock a beat before this
        // drain dispatched. That's benign — the lock holder drains the source, so
        // our /update was redundant, not failed. Classify it as `drain-superseded`
        // (info) rather than `drain-failed` so expected lock contention doesn't
        // pollute the drain-error signal. Every other non-ok status (spend cap
        // 429, kill switch 503, mint failure) is a genuine drop worth a warn.
        const superseded = res.status === 409;
        logEvent(superseded ? "info" : "warn", {
          component: "org-actor",
          event: superseded ? "drain-superseded" : "drain-failed",
          orgId,
          status: res.status,
          detail: body.slice(0, 200),
          sourceCount: sourceIdentifiers.length,
        });
        return;
      }
      const { sessionId } = (await res.json().catch((err) => {
        logEvent("warn", {
          component: "org-actor",
          event: "drain-response-bad-json",
          orgId,
          error: err,
        });
        return {};
      })) as { sessionId?: string };
      logEvent("info", {
        component: "org-actor",
        event: "drain-dispatched",
        orgId,
        sessionId: sessionId ?? null,
        sourceCount: sourceIdentifiers.length,
      });
      // Stamp the drain cooldown (#1862) for every source in the accepted
      // /update. queryCandidates excludes these for DRAIN_COOLDOWN_MS, so a
      // still-flagged source (e.g. one that's permanently un-fetchable) can't
      // re-dispatch a no-op Haiku session on the next SourceActor poll tick.
      // Only stamped on success — a rejected /update (spend cap / lock / kill
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
