/**
 * Manifest sweep (#1947): discover UNLISTED domains from captured lookup misses
 * (domain_demand) and auto-create a stub org for any that publish a valid
 * /.well-known/releases.json. Demand-driven counterpart to well-known-sync,
 * which only reconciles already-listed orgs. Dispatched from the well-known
 * daily tick, gated on listing-self-serve-enabled.
 *
 * Reuses createStubFromManifest as the single activation core — it fetches
 * (HTTPS-only + isPrivateOrLocalHost SSRF screen), validates against the v2
 * schema, and applies every carve-out (org-exists / registry-org / reserved-slug
 * / invalid-manifest skips). The sweep never sets tracking_requested_at: a
 * sweep-discovered stub sits at the bottom of the ladder until real demand.
 */
import { and, asc, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { domainDemand, organizations } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { createDb, type D1Db } from "../db.js";
import { createStubFromManifest } from "../lib/well-known/stub.js";
import { affectedRows } from "../lib/well-known/promote.js";
import { makeBotFetch, type WebBotAuthEnv } from "../lib/web-bot-auth-fetch.js";

const SWEEP_RETRY_DAYS = 7; // re-probe cadence for a domain the sweep found nothing on
const MAX_PER_RUN = 100; // effective per-run stub-creation cap; << CF 1000-subrequest ceiling
const PRUNE_STALE_DAYS = 30; // age past which a single-hit, already-probed junk row is deleted
const DAY_MS = 86_400_000;

export interface DomainDemandSweepEnv extends WebBotAuthEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  FLAGS?: FlagshipBinding;
  LISTING_SELF_SERVE_ENABLED?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: D1Db;
  /** TEST-ONLY / injectable: manifest fetch. When omitted, uses makeBotFetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface DomainDemandSweepResult {
  processed: number;
  created: number;
  pruned: number;
}

/**
 * Sweep `domain_demand` for unlisted, due, highest-demand domains and probe
 * each for a valid owner-declared manifest via `createStubFromManifest`.
 * Every probed row (hit or miss) is stamped with `swept_at` so the due-filter
 * advances regardless of outcome. Finishes with a prune pass that deletes
 * stale single-hit already-probed junk, leaving repeat-demand rows alone.
 */
export async function domainDemandSweep(
  env: DomainDemandSweepEnv,
): Promise<DomainDemandSweepResult> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "listing", event: "domain-demand-sweep-cron-disabled" });
    return { processed: 0, created: 0, pruned: 0 };
  }

  const enabled = await flag(
    env.FLAGS,
    env.LISTING_SELF_SERVE_ENABLED,
    FLAGS.listingSelfServeEnabled,
  );
  if (!enabled) {
    logEvent("info", { component: "listing", event: "domain-demand-sweep-disabled" });
    return { processed: 0, created: 0, pruned: 0 };
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const now = Date.now();
  const cutoff = now - SWEEP_RETRY_DAYS * DAY_MS;
  // Prefer injectable fetch (tests); otherwise sign with the registered bot identity.
  const fetchImpl = env.fetchImpl ?? (await makeBotFetch(env));

  // Candidates: unlisted (anti-join organizations.domain), due, highest-demand
  // then least-recently-probed. NULL swept_at sorts first under ASC in SQLite.
  const candidates = await db
    .select({ domain: domainDemand.domain })
    .from(domainDemand)
    .leftJoin(
      organizations,
      and(eq(organizations.domain, domainDemand.domain), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        isNull(organizations.id),
        or(isNull(domainDemand.sweptAt), lt(domainDemand.sweptAt, cutoff)),
      ),
    )
    .orderBy(desc(domainDemand.hitCount), asc(domainDemand.sweptAt))
    .limit(MAX_PER_RUN);

  let created = 0;
  const skipped: Record<string, number> = {};

  for (const { domain } of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-domain manifest fetch; bounded by MAX_PER_RUN
      const r = await createStubFromManifest(db, domain, { fetchImpl });
      if (r.created) {
        created++;
        logEvent("info", {
          component: "listing",
          event: "domain-demand-stub-created",
          domain,
          orgId: r.orgId,
          locationCount: r.locationCount,
        });
      } else {
        skipped[r.skippedReason ?? "unknown"] = (skipped[r.skippedReason ?? "unknown"] ?? 0) + 1;
      }
    } catch (err) {
      logEvent("error", {
        component: "listing",
        event: "domain-demand-stub-failed",
        domain,
        err: err instanceof Error ? err : String(err),
      });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- advance the due-filter clock per row regardless of outcome
      await db.update(domainDemand).set({ sweptAt: now }).where(eq(domainDemand.domain, domain));
    } catch (err) {
      logEvent("warn", {
        component: "listing",
        event: "domain-demand-stamp-failed",
        domain,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Prune: single-hit, already-probed, stale junk. Never touches repeat demand
  // (hit_count > 1) or unprobed rows (swept_at NULL).
  const pruneCutoff = now - PRUNE_STALE_DAYS * DAY_MS;
  const pruneResult = await db
    .delete(domainDemand)
    .where(
      and(
        eq(domainDemand.hitCount, 1),
        isNotNull(domainDemand.sweptAt),
        lt(domainDemand.lastSeenAt, pruneCutoff),
      ),
    );
  const pruned = affectedRows(pruneResult);

  logEvent("info", {
    component: "listing",
    event: "domain-demand-sweep-done",
    processed: candidates.length,
    created,
    skipped,
    pruned,
    capped: candidates.length >= MAX_PER_RUN,
  });

  return { processed: candidates.length, created, pruned };
}
