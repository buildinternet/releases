/**
 * No-results stats for the search-queries log: how many queries returned zero
 * hits in a window, and which queries those were. Powers the Tier-2 alert that
 * fires when the no-results rate crosses a threshold.
 *
 * "Zero hits" means a row was actually scored (at least one of the four hit
 * columns is non-null) and the sum across them is zero. Rows with all-null
 * hit columns are excluded from numerator and denominator alike — we only
 * know about hit counts when the surface logged them.
 */
import { and, desc, gt, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { searchQueries } from "@buildinternet/releases-core/schema";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";
import { buildBotCondition } from "./search-queries-top.js";

/** SQL: at least one of the four hit columns is non-null (i.e., row was scored). */
function hasScoredHitsCondition(): SQL {
  return or(
    not(isNull(searchQueries.orgHits)),
    not(isNull(searchQueries.catalogHits)),
    not(isNull(searchQueries.releaseHits)),
    not(isNull(searchQueries.chunkHits)),
  ) as SQL;
}

/** SQL: SUM(coalesce(orgHits,0)+catalog+release+chunk) === 0. */
function zeroHitsSqlCondition(): SQL {
  return sql`(coalesce(${searchQueries.orgHits}, 0) + coalesce(${searchQueries.catalogHits}, 0) + coalesce(${searchQueries.releaseHits}, 0) + coalesce(${searchQueries.chunkHits}, 0)) = 0`;
}

export type ZeroHitRow = {
  query: string;
  count: number;
  lastSeen: number;
};

export type NoResultsStats = {
  /** Scored rows in window (denominator). */
  total: number;
  /** Subset of `total` whose hit-sum is zero. */
  zeroHits: number;
  /** Top zero-hit queries grouped by text, ordered by count desc. */
  topQueries: ZeroHitRow[];
};

export interface NoResultsOptions {
  /** Unix-epoch milliseconds; rows with `timestamp > since` are included. */
  since: number;
  /** Maximum number of grouped zero-hit queries to return. Defaults to 20. */
  topLimit?: number;
  /** Whether to exclude bot/crawler rows. Defaults to `true`. */
  excludeBots?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getNoResultsStats(db: any, opts: NoResultsOptions): Promise<NoResultsStats> {
  const topLimit = opts.topLimit ?? 20;
  const excludeBots = opts.excludeBots ?? true;

  const baseConds: SQL[] = [gt(searchQueries.timestamp, opts.since), hasScoredHitsCondition()];
  if (excludeBots) {
    const bc = buildBotCondition("exclude");
    if (bc) baseConds.push(bc);
  }

  // One pass for total + zero-hit count.
  const totalsRow = await db
    .select({
      total: sql<number>`count(*)`.as("total"),
      zeroHits:
        sql<number>`sum(case when (coalesce(${searchQueries.orgHits}, 0) + coalesce(${searchQueries.catalogHits}, 0) + coalesce(${searchQueries.releaseHits}, 0) + coalesce(${searchQueries.chunkHits}, 0)) = 0 then 1 else 0 end)`.as(
          "zeroHits",
        ),
    })
    .from(searchQueries)
    .where(and(...baseConds));

  const total = Number(totalsRow[0]?.total ?? 0);
  const zeroHits = Number(totalsRow[0]?.zeroHits ?? 0);

  if (zeroHits === 0) {
    return { total, zeroHits, topQueries: [] };
  }

  const countExpr = sql<number>`count(*)`.as("count");
  const topRows = await db
    .select({
      query: searchQueries.query,
      count: countExpr,
      lastSeen: sql<number>`max(${searchQueries.timestamp})`.as("lastSeen"),
    })
    .from(searchQueries)
    .where(and(...baseConds, zeroHitsSqlCondition()))
    .groupBy(searchQueries.query)
    .orderBy(desc(countExpr))
    .limit(topLimit);

  return {
    total,
    zeroHits,
    topQueries: topRows.map((r: ZeroHitRow) => ({
      query: r.query,
      count: Number(r.count),
      lastSeen: Number(r.lastSeen),
    })),
  };
}

export type NoResultsThresholds = {
  /** Percent (0–100). Alert fires when `zeroHits/total * 100 > thresholdPct`. */
  thresholdPct: number;
  /** Minimum scored-and-non-bot volume before the ratio matters. */
  minVolume: number;
};

export type NoResultsDecision = { fire: false; reason: string } | { fire: true; ratio: number };

/** Pure threshold check — no I/O — so callers can unit-test without seeding. */
export function evaluateNoResultsAlert(
  stats: NoResultsStats,
  thresholds: NoResultsThresholds,
): NoResultsDecision {
  if (stats.total < thresholds.minVolume) {
    return { fire: false, reason: `volume ${stats.total} < min ${thresholds.minVolume}` };
  }
  const ratio = stats.total === 0 ? 0 : stats.zeroHits / stats.total;
  const ratioPct = ratio * 100;
  if (ratioPct <= thresholds.thresholdPct) {
    return {
      fire: false,
      reason: `ratio ${ratioPct.toFixed(1)}% <= threshold ${thresholds.thresholdPct}%`,
    };
  }
  return { fire: true, ratio };
}

/**
 * Plain-text alert body — kept byte-for-byte as it was before the email-shell
 * migration (existing callers/tests depend on this exact shape). New callers
 * should reach for `buildNoResultsAlert` below, which renders the same stats
 * through the shared shell and gains an HTML twin.
 */
export function formatNoResultsAlertBody(
  stats: NoResultsStats,
  decision: { fire: true; ratio: number },
  thresholds: NoResultsThresholds,
): string {
  const lines = [
    `No-results rate exceeded threshold over the last 24h.`,
    ``,
    `Total scored queries: ${stats.total}`,
    `Zero-hit queries: ${stats.zeroHits} (${(decision.ratio * 100).toFixed(1)}%)`,
    `Threshold: ${thresholds.thresholdPct}% over ${thresholds.minVolume}+ queries`,
    ``,
    `Top zero-hit queries:`,
  ];
  if (stats.topQueries.length === 0) {
    lines.push(`  (none)`);
  } else {
    for (const row of stats.topQueries) {
      lines.push(`  ${row.count.toString().padStart(4, " ")}  ${row.query}`);
    }
  }
  return lines.join("\n");
}

/** Render the same no-results alert through the shared email shell — subject + both bodies. */
export function buildNoResultsAlert(
  stats: NoResultsStats,
  decision: { fire: true; ratio: number },
  thresholds: NoResultsThresholds,
): { subject: string; text: string; html: string } {
  const pct = (decision.ratio * 100).toFixed(1);
  // Lead with the query people are actually missing on: the ratio says how bad
  // it is, the query says what to go fix. The count sits outside the quotes so
  // the quoted text is exactly what someone typed.
  const topMiss = stats.topQueries[0]?.query;
  const otherMisses = Math.max(0, stats.topQueries.length - 1);
  const missSegment = topMiss
    ? ` — "${topMiss}"${otherMisses > 0 ? ` +${otherMisses} more` : ""}`
    : "";
  const subject = `[alert] search no-results: ${pct}% zero-hit (${stats.zeroHits}/${stats.total})${missSegment}`;

  const blocks: EmailBlock[] = [
    {
      t: "data",
      rows: [
        { label: "Total", value: String(stats.total) },
        { label: "Zero-hit", value: `${stats.zeroHits} (${pct}%)`, kind: "err" },
        {
          label: "Threshold",
          value: `${thresholds.thresholdPct}% over ${thresholds.minVolume}+ queries`,
        },
      ],
    },
  ];
  blocks.push({ t: "kicker", text: "Top misses" });
  if (stats.topQueries.length === 0) {
    blocks.push({ t: "fine", text: "(none)" });
  } else {
    for (const row of stats.topQueries) {
      blocks.push({
        t: "entity",
        coord: row.query,
        metrics: `${row.count}x · last seen ${new Date(row.lastSeen).toISOString()}`,
      });
    }
  }

  const { html, text } = renderEmail({
    lane: "Alert · Search",
    tone: "warn",
    title: "No-results rate exceeded threshold",
    subtitle: "last 24h",
    blocks,
    footer: {
      reason:
        "Automated alert from Releases — the search no-results rate crossed its configured threshold over the last 24h.",
    },
  });

  return { subject, text, html };
}

export const DEFAULT_THRESHOLD_PCT = 20;
export const DEFAULT_MIN_VOLUME = 50;

function parseBounded(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

/** Parse `SEARCH_NO_RESULTS_*` env vars with bounds + sensible defaults. */
export function parseThresholds(env: {
  SEARCH_NO_RESULTS_THRESHOLD_PCT?: string;
  SEARCH_NO_RESULTS_MIN_VOLUME?: string;
}): NoResultsThresholds {
  return {
    thresholdPct: parseBounded(env.SEARCH_NO_RESULTS_THRESHOLD_PCT, DEFAULT_THRESHOLD_PCT, 100),
    minVolume: Math.floor(parseBounded(env.SEARCH_NO_RESULTS_MIN_VOLUME, DEFAULT_MIN_VOLUME)),
  };
}
