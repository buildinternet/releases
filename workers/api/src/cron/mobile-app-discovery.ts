import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { logEvent } from "@releases/lib/log-event";
import { discoverMobileApps } from "../lib/well-known/mobile-apps.js";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

/**
 * Daily sweep that discovers each org's native mobile apps from its AASA +
 * assetlinks.json well-known files (see `lib/well-known/mobile-apps.ts`). Runs
 * as its OWN cron invocation — separate from the `releases.json` well-known
 * sweep — so its outbound subrequests get a fresh Cloudflare 1000-per-invocation
 * budget rather than sharing the config sweep's.
 *
 * Worst-case subrequests per run: `maxPerRun × (2 + maxAppsPerOrg)` — two
 * well-known fetches plus up to `maxAppsPerOrg` iTunes lookups per org. Defaults
 * (100 × (2 + 5) = 700) stay under the ceiling. Due-filter + oldest-first
 * ordering mean steady-state runs process far fewer.
 */

export interface MobileAppDiscoveryEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  FLAGS?: FlagshipBinding;
  WELL_KNOWN_MATERIALIZATION_ENABLED?: string;
  /** Re-check interval in hours; an org swept more recently is skipped. Default
   *  720 (30d) — a domain's app inventory changes rarely. Floor 1h; invalid → default. */
  MOBILE_DISCOVERY_INTERVAL_HOURS?: string;
  /** Hard cap on orgs processed per run, oldest-first. Default 100. Floor 1; invalid → default. */
  MOBILE_DISCOVERY_MAX_PER_RUN?: string;
  /** Cap on iTunes lookups per org. Default 5. Floor 1; invalid → default. */
  MOBILE_DISCOVERY_MAX_APPS_PER_ORG?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). Typed
   *  `unknown` (mirrors source-staleness) so the bun:sqlite test handle assigns. */
  _drizzleOverride?: unknown;
  /** TEST-ONLY: inject fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_INTERVAL_HOURS = 720; // 30 days
const DEFAULT_MAX_PER_RUN = 100;
const DEFAULT_MAX_APPS_PER_ORG = 5;

type Db = ReturnType<typeof createDb>;

function positiveIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Patch only `metadata.mobileAppsSweptAt` (a due-filter clock distinct from the
 *  config sweep's `wellKnownSweptAt`), advancing on every outcome. */
async function stampSwept(db: Db, id: string, iso: string): Promise<void> {
  await db
    .update(organizations)
    .set({
      metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.mobileAppsSweptAt', ${iso})`,
    })
    .where(eq(organizations.id, id));
}

export async function mobileAppDiscoverySweep(env: MobileAppDiscoveryEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "mobile-discovery", event: "cron-disabled" });
    return;
  }
  const db = (env._drizzleOverride as Db | undefined) ?? createDb(env.DB);
  const enabled = await flag(
    env.FLAGS,
    env.WELL_KNOWN_MATERIALIZATION_ENABLED,
    FLAGS.wellKnownMaterializationEnabled,
  );

  const intervalHours = positiveIntOr(env.MOBILE_DISCOVERY_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS);
  const maxPerRun = positiveIntOr(env.MOBILE_DISCOVERY_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const maxAppsPerOrg = positiveIntOr(
    env.MOBILE_DISCOVERY_MAX_APPS_PER_ORG,
    DEFAULT_MAX_APPS_PER_ORG,
  );
  const now = new Date();
  const cutoff = new Date(now.getTime() - intervalHours * 3600_000).toISOString();

  const sweptAt = sql<
    string | null
  >`json_extract(${organizations.metadata}, '$.mobileAppsSweptAt')`;
  const orgs = await db
    .select({ id: organizations.id, domain: organizations.domain })
    .from(organizations)
    .where(
      and(
        eq(organizations.fetchPaused, false),
        isNull(organizations.deletedAt),
        or(sql`${sweptAt} IS NULL`, lt(sweptAt, cutoff)),
      ),
    )
    .orderBy(asc(sweptAt))
    .limit(maxPerRun);

  let candidatesCreated = 0;
  let orgsWithApps = 0;
  for (const o of orgs) {
    // A null domain is a safe no-op inside discoverMobileApps (no I/O), so every
    // org flows through the one probe+stamp path — no special-cased branch.
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-org to bound subrequests
      const r = await discoverMobileApps(db, o.id, {
        domain: o.domain,
        enabled,
        maxAppsPerOrg,
        fetchImpl: env.fetchImpl,
      });
      const created = r.ios.filter((a) => a.action === "created").length;
      candidatesCreated += created;
      if (created > 0 || r.android.length > 0) orgsWithApps++;
    } catch (err) {
      logEvent("error", {
        component: "mobile-discovery",
        event: "org-probe-failed",
        orgId: o.id,
        err: err instanceof Error ? err : String(err),
      });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- advance the due-filter clock per row regardless of outcome
      await stampSwept(db, o.id, now.toISOString());
    } catch (err) {
      logEvent("warn", {
        component: "mobile-discovery",
        event: "stamp-failed",
        orgId: o.id,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  logEvent("info", {
    component: "mobile-discovery",
    event: "sweep-done",
    orgProcessed: orgs.length,
    orgsWithApps,
    candidatesCreated,
    orgCapped: orgs.length >= maxPerRun,
    maxPerRun,
    maxAppsPerOrg,
    intervalHours,
    enabled,
  });
}
