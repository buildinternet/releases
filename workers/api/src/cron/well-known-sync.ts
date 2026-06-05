import { isNull, eq, and } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { syncOrgWellKnown } from "../lib/well-known/reconcile-org.js";
import { syncSourceRepo } from "../lib/well-known/reconcile-source.js";

export interface WellKnownSyncEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  MEDIA_ORIGIN?: string;
  FLAGS?: FlagshipBinding;
  WELL_KNOWN_SYNC_ENABLED?: string;
  CRON_ENABLED?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: ReturnType<typeof createDb>;
  /** TEST-ONLY: inject fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export async function wellKnownSync(env: WellKnownSyncEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "well-known", event: "cron-disabled" });
    return;
  }
  if (!(await flag(env.FLAGS, env.WELL_KNOWN_SYNC_ENABLED, FLAGS.wellKnownSyncEnabled))) {
    logEvent("info", { component: "well-known", event: "flag-off" });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const mediaOrigin = env.MEDIA_ORIGIN ?? "https://media.releases.sh";
  let orgApplied = 0;
  let sourceApplied = 0;

  // Pass 1: org identity from domain .well-known files.
  const orgs = await db
    .select({ id: organizations.id, domain: organizations.domain })
    .from(organizations)
    .where(and(eq(organizations.fetchPaused, false), isNull(organizations.deletedAt)));
  for (const o of orgs) {
    if (!o.domain) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-org to avoid concurrent R2 + D1 pressure on the cron budget
      const r = await syncOrgWellKnown(db, o.id, {
        bucket: env.MEDIA,
        mediaOrigin,
        domain: o.domain,
        fetchImpl: env.fetchImpl,
      });
      if (r.applied) orgApplied++;
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "org-sync-failed",
        orgId: o.id,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Both passes iterate the full corpus sequentially — no cap. Fine at current
  // scale; fair-rotation/batching (a last-swept-at column + due-filtering, like
  // poll-and-fetch) is deferred to Tier 2 if the org/source count grows large.
  // Pass 2: source→product mapping from repo-root releases.json files. Join the
  // org so a github source under a paused/deleted org is skipped too — mirrors
  // Pass 1's org predicates. (Org soft-delete already cascades deletedAt to its
  // sources, so the org deletedAt check is belt-and-suspenders against a cascade
  // gap; the fetchPaused check is the one Pass 2 would otherwise miss.)
  const ghSources = await db
    .select({ id: sources.id })
    .from(sources)
    .innerJoin(organizations, eq(sources.orgId, organizations.id))
    .where(
      and(
        eq(sources.type, "github"),
        isNull(sources.deletedAt),
        eq(organizations.fetchPaused, false),
        isNull(organizations.deletedAt),
      ),
    );
  for (const s of ghSources) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-source to avoid concurrent GitHub raw-content fetch pressure
      const r = await syncSourceRepo(db, s.id, { fetchImpl: env.fetchImpl });
      if (r.applied) sourceApplied++;
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "source-sync-failed",
        sourceId: s.id,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  logEvent("info", { component: "well-known", event: "sweep-done", orgApplied, sourceApplied });
}
