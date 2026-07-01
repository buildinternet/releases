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
