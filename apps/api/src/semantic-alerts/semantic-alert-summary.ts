/**
 * Admin read path for semantic-alert points in the classifications dataset.
 *
 * Same Analytics Engine credentials, sampling weight, and timestamp rules as
 * marketing classifications. `blob4` is `semantic-alert`. Alert query text is
 * not selected — it is not on the point. Cost is not summed here: one JEV
 * call covers many alerts, so a per-alert double would over-count. Spend
 * stays on `ai_usage` (`lane: semantic-alert-match`).
 */
import { SEMANTIC_ALERT_THRESHOLD_DEFAULT } from "@buildinternet/releases-api-types";
import type { SemanticAlertSummary } from "@buildinternet/releases-api-types";
import { ReleasesError } from "@releases/lib/releases-error";
import {
  CLASSIFICATION_ORIGINS,
  CLASSIFICATION_RETENTION_DAYS,
  classificationDatasetName,
} from "../lib/classification/classification-schema.js";
import {
  aeTimestampToIso,
  countOf,
  datasetSql,
  enumLiteral,
  histogramColumns,
  intervalSql,
  prefixedSummaryCacheKey,
  queryClassificationDataset,
  schemaVersionLiteral,
  sqlDateTime,
  summaryCacheMaterial,
  type AeRow,
  type ValidatedSummary,
} from "../lib/classification/classification-query.js";

export const SEMANTIC_ALERT_SUMMARY_CACHE_PREFIX = "semantic-alert-summary:v1:";
export const SEMANTIC_ALERT_COST_LANE = "semantic-alert-match";

const CLASSIFICATION_TYPE = "semantic-alert";
const DISPOSITIONS = ["matched", "below_threshold", "failed"] as const;
const FAILURE_CATEGORIES = ["provider_error", "invalid_probability"] as const;

type Disposition = (typeof DISPOSITIONS)[number];
type FailureCategory = SemanticAlertSummary["failures"][number]["category"];

export interface SemanticAlertSummaryStatements {
  totals: string;
  series: string;
  histogram: string;
  failures: string;
}

function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

function failureCategory(value: unknown): FailureCategory {
  if (typeof value === "string" && (FAILURE_CATEGORIES as readonly string[]).includes(value)) {
    return value as FailureCategory;
  }
  return "unknown";
}

function whereSql(query: ValidatedSummary): string {
  const parts = [
    `blob1 = ${schemaVersionLiteral()}`,
    `blob4 = ${enumLiteral(CLASSIFICATION_TYPE, [CLASSIFICATION_TYPE])}`,
    `timestamp >= ${sqlDateTime(query.afterMs)}`,
    `timestamp < ${sqlDateTime(query.beforeMs)}`,
  ];
  if (query.origin !== "all") {
    parts.push(`blob3 = ${enumLiteral(query.origin, CLASSIFICATION_ORIGINS)}`);
  }
  return parts.join(" AND ");
}

export function buildSemanticAlertSummaryStatements(
  query: ValidatedSummary,
  dataset: string,
): SemanticAlertSummaryStatements {
  const from = datasetSql(dataset);
  const where = whereSql(query);
  const bucketExpr = `toStartOfInterval(timestamp, ${intervalSql(query.bucket)})`;
  const failed = enumLiteral("failed", DISPOSITIONS);
  return {
    totals:
      `SELECT blob10 AS disposition, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} GROUP BY blob10 LIMIT 20`,
    series:
      `SELECT ${bucketExpr} AS t, blob10 AS disposition, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} GROUP BY t, blob10 ORDER BY t LIMIT 10000`,
    histogram: `SELECT ${histogramColumns("double1", "selected")} FROM ${from} WHERE ${where}`,
    failures:
      `SELECT blob13 AS category, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} AND blob10 = ${failed} GROUP BY blob13 ORDER BY samples DESC LIMIT 20`,
  };
}

function emptySeriesPoint(t: string): SemanticAlertSummary["series"][number] {
  return { t, matched: 0, belowThreshold: 0, failed: 0 };
}

const BIN_COUNT = 10;

function emptyBins(): SemanticAlertSummary["probability"]["bins"] {
  return Array.from({ length: BIN_COUNT }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    count: 0,
  }));
}

export function shapeSemanticAlertSummary(input: {
  afterIso: string;
  beforeIso: string;
  bucket: ValidatedSummary["bucket"];
  dataset: string;
  totals: AeRow[];
  series: AeRow[];
  histogram: AeRow[];
  failures: AeRow[];
}): SemanticAlertSummary {
  const counts = { matched: 0, belowThreshold: 0, failed: 0 };
  for (const row of input.totals) {
    if (!isDisposition(row.disposition)) continue;
    const samples = countOf(row.samples);
    if (row.disposition === "matched") counts.matched += samples;
    else if (row.disposition === "below_threshold") counts.belowThreshold += samples;
    else counts.failed += samples;
  }
  const scored = counts.matched + counts.belowThreshold;

  const seriesMap = new Map<string, SemanticAlertSummary["series"][number]>();
  for (const row of input.series) {
    const t = aeTimestampToIso(row.t);
    if (!t || !isDisposition(row.disposition)) continue;
    const bucket = seriesMap.get(t) ?? emptySeriesPoint(t);
    const samples = countOf(row.samples);
    if (row.disposition === "matched") bucket.matched += samples;
    else if (row.disposition === "below_threshold") bucket.belowThreshold += samples;
    else bucket.failed += samples;
    seriesMap.set(t, bucket);
  }

  const bins = emptyBins();
  const histogram = input.histogram[0];
  for (let i = 0; i < BIN_COUNT; i++) {
    const bin = bins[i];
    if (bin) bin.count = countOf(histogram?.[`selected_${i}`]);
  }

  const failureCounts = new Map<FailureCategory, number>();
  for (const row of input.failures) {
    const category = failureCategory(row.category);
    failureCounts.set(category, (failureCounts.get(category) ?? 0) + countOf(row.samples));
  }
  const failures = [...failureCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({ category, count }))
    .toSorted((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    after: input.afterIso,
    before: input.beforeIso,
    bucket: input.bucket,
    totals: {
      scored,
      matched: counts.matched,
      belowThreshold: counts.belowThreshold,
      failed: counts.failed,
      matchRate: scored === 0 ? null : counts.matched / scored,
    },
    series: [...seriesMap.values()].toSorted((a, b) => a.t.localeCompare(b.t)),
    failures,
    probability: {
      defaultThreshold: SEMANTIC_ALERT_THRESHOLD_DEFAULT,
      bins,
      missing: countOf(histogram?.selected_missing),
    },
    meta: {
      dataset: input.dataset,
      retentionDays: CLASSIFICATION_RETENTION_DAYS,
      sampled: true,
      costLane: SEMANTIC_ALERT_COST_LANE,
    },
  };
}

export function semanticAlertSummaryCacheMaterial(
  query: ValidatedSummary,
  dataset: string,
): string {
  return `semantic-alert\n${summaryCacheMaterial(query, dataset)}`;
}

export async function semanticAlertSummaryCacheKey(material: string): Promise<string> {
  return prefixedSummaryCacheKey(SEMANTIC_ALERT_SUMMARY_CACHE_PREFIX, material);
}

type AeEnv = Parameters<typeof queryClassificationDataset>[0];

export async function fetchSemanticAlertSummary(
  env: AeEnv,
  query: ValidatedSummary,
  fetchImpl: typeof fetch = fetch,
): Promise<SemanticAlertSummary | ReleasesError> {
  const dataset = classificationDatasetName(env.ENVIRONMENT);
  const rows = await queryClassificationDataset(
    env,
    buildSemanticAlertSummaryStatements(query, dataset),
    fetchImpl,
  );
  if (rows instanceof ReleasesError) return rows;
  return shapeSemanticAlertSummary({
    afterIso: query.afterIso,
    beforeIso: query.beforeIso,
    bucket: query.bucket,
    dataset,
    totals: rows.totals ?? [],
    series: rows.series ?? [],
    histogram: rows.histogram ?? [],
    failures: rows.failures ?? [],
  });
}
