/**
 * Admin read path for marketing-classification points in Analytics Engine.
 *
 * AE SQL has no bound parameters. Every interpolated value is an allowlisted
 * literal, a regex-checked token, or a timestamp this module formatted and
 * re-checked. User input is never escaped into SQL — a value that fails
 * validation is rejected before a statement is built.
 *
 * Absent doubles are the sentinel -1. Aggregates must not treat that as a
 * real cost or probability. Counts use SUM(_sample_interval); the recent
 * list returns sampled rows and does not weight them.
 */
import { eq, inArray } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import type {
  ClassificationRecentItem,
  ClassificationRecentResponse,
  ClassificationSummary,
} from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import {
  ReleasesError,
  ServiceUnavailableError,
  UpstreamError,
  ValidationError,
} from "@releases/lib/releases-error";
import {
  CLASSIFICATION_BUCKETS,
  CLASSIFICATION_DISPOSITIONS,
  CLASSIFICATION_ORIGINS,
  CLASSIFICATION_RETENTION_DAYS,
  CLASSIFICATION_SCHEMA_VERSION,
  DATASET_PRODUCTION,
  DATASET_STAGING,
  MARKETING_SUPPRESSION_THRESHOLD,
  classificationDatasetName,
  type ClassificationBucket,
  type ClassificationDisposition,
  type ClassificationOrigin,
} from "./classification-schema.js";
import { resolveCloudflareAeCredentials } from "../../webhooks/shared.js";
import { loadMarketingThreshold } from "./marketing-classifier-settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 100 * DAY_MS;
const DEFAULT_RANGE_MS = 7 * DAY_MS;
const HOUR_BUCKET_MAX_MS = 48 * 60 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 100;

/** Operator-facing freshness. KV itself refuses TTLs under 60s — see the writer. */
export const SUMMARY_CACHE_TTL_MS = 45_000;
export const SUMMARY_CACHE_KV_TTL_SECONDS = 60;
export const SUMMARY_CACHE_PREFIX = "classification-summary:v1:";

const AE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const SOURCE_ID_RE = /^src_[A-Za-z0-9_-]{1,64}$/;
const RELEASE_ID_RE = /^rel_[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:/@+-]{1,80}$/;
const LIMIT_RE = /^\d+$/;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?)?$/;

const ORIGINS = new Set<string>(CLASSIFICATION_ORIGINS);
const DISPOSITIONS = new Set<string>(CLASSIFICATION_DISPOSITIONS);
const BUCKETS = new Set<string>(CLASSIFICATION_BUCKETS);

export interface ClassificationQueryInput {
  after?: string;
  before?: string;
  origin?: string;
  sourceId?: string;
}

export interface SummaryQueryInput extends ClassificationQueryInput {
  bucket?: string;
  model?: string;
}

export interface RecentQueryInput extends ClassificationQueryInput {
  choice?: string;
  disposition?: string;
  limit?: string;
  cursor?: string;
}

export interface ValidatedWindow {
  afterMs: number;
  beforeMs: number;
  afterIso: string;
  beforeIso: string;
  afterSupplied: boolean;
  beforeSupplied: boolean;
  origin: ClassificationOrigin | "all";
  sourceId?: string;
}

export interface ValidatedSummary extends ValidatedWindow {
  bucket: ClassificationBucket;
  model?: string;
}

export interface ValidatedRecent extends ValidatedWindow {
  choice?: string;
  disposition?: ClassificationDisposition;
  limit: number;
  /** Cursor collapsed the window; there is nothing to query. */
  skipQuery: boolean;
}

export interface SummaryStatements {
  totals: string;
  series: string;
  choices: string;
  choiceSeries: string;
  models: string;
  histogram: string;
}

export interface ClassificationCacheKv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type AeRow = Record<string, unknown>;
type AeEnv = Parameters<typeof resolveCloudflareAeCredentials>[0] & {
  ENVIRONMENT?: string;
  DB?: D1Database;
};

interface HydratedSource {
  name: string;
  slug: string;
  orgSlug: string | null;
}

function badRequest(message: string): ValidationError {
  return new ValidationError(message, { code: "bad_request" });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse an ISO-ish timestamp as UTC. Rejects anything that is not a calendar date. */
function parseTimestamp(raw: string): number | null {
  if (raw.length > 40) return null;
  const m = TIMESTAMP_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const frac = m[7]?.slice(1) ?? "";
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  const zone = m[8];
  if (zone && zone !== "Z") {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${pad(hour)}:${pad(minute)}:${pad(second)}.${String(ms).padStart(3, "0")}${zone}`;
    const epoch = Date.parse(iso);
    return Number.isFinite(epoch) ? epoch : null;
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const d = new Date(epoch);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second
  ) {
    return null;
  }
  return epoch;
}

function formatAeTimestamp(ms: number): string {
  const d = new Date(ms);
  const formatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (!AE_TIMESTAMP_RE.test(formatted)) {
    throw new Error("refusing to interpolate unsafe timestamp");
  }
  return formatted;
}

export function sqlDateTime(ms: number): string {
  return `toDateTime('${formatAeTimestamp(ms)}')`;
}

/** Quote a value that already matches `pattern`. Throws instead of escaping. */
function quoteLiteral(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error("refusing to interpolate unsafe literal");
  return `'${value}'`;
}

/** Quote a value already constrained to `allowed`. Throws instead of escaping. */
export function enumLiteral(value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) throw new Error("refusing to interpolate enum");
  return `'${value}'`;
}

function originPredicate(origin: ValidatedWindow["origin"]): string | null {
  if (origin === "all") return null;
  return `blob3 = ${enumLiteral(origin, CLASSIFICATION_ORIGINS)}`;
}

function dispositionPredicate(disposition: ClassificationDisposition): string {
  return `blob10 = ${enumLiteral(disposition, CLASSIFICATION_DISPOSITIONS)}`;
}

export function intervalSql(bucket: ClassificationBucket): string {
  if (bucket === "hour") return "INTERVAL '1' HOUR";
  if (bucket === "day") return "INTERVAL '1' DAY";
  throw new Error("refusing to interpolate bucket");
}

export function datasetSql(name: string): string {
  if (name === DATASET_PRODUCTION || name === DATASET_STAGING) return name;
  throw new Error("refusing to interpolate dataset");
}

export function schemaVersionLiteral(): string {
  if (!/^[0-9]+$/.test(CLASSIFICATION_SCHEMA_VERSION)) {
    throw new Error("refusing to interpolate schema version");
  }
  return `'${CLASSIFICATION_SCHEMA_VERSION}'`;
}

function whereClause(filter: {
  afterMs: number;
  beforeMs: number;
  origin: ValidatedWindow["origin"];
  model?: string;
  sourceId?: string;
  choice?: string;
  disposition?: ClassificationDisposition;
}): string {
  const parts = [
    `blob1 = ${schemaVersionLiteral()}`,
    "blob4 = 'marketing'",
    `timestamp >= ${sqlDateTime(filter.afterMs)}`,
    `timestamp < ${sqlDateTime(filter.beforeMs)}`,
  ];
  const origin = originPredicate(filter.origin);
  if (origin) parts.push(origin);
  if (filter.model) parts.push(`blob8 = ${quoteLiteral(filter.model, TOKEN_RE)}`);
  if (filter.sourceId) parts.push(`blob6 = ${quoteLiteral(filter.sourceId, SOURCE_ID_RE)}`);
  if (filter.choice) parts.push(`blob9 = ${quoteLiteral(filter.choice, TOKEN_RE)}`);
  if (filter.disposition) parts.push(dispositionPredicate(filter.disposition));
  return parts.join(" AND ");
}

export function histogramColumns(
  column: "double1" | "double2",
  prefix: "selected" | "confidence",
): string {
  const parts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const start = (i / 10).toFixed(1);
    const end = ((i + 1) / 10).toFixed(1);
    const upper = i === 9 ? `${column} <= 1.0` : `${column} < ${end}`;
    parts.push(
      `SUM(if((${column} >= ${start}) AND (${upper}), _sample_interval, 0)) AS ${prefix}_${i}`,
    );
  }
  parts.push(`SUM(if(${column} < 0, _sample_interval, 0)) AS ${prefix}_missing`);
  return parts.join(", ");
}

function parseOrigin(raw: string | undefined): ValidatedWindow["origin"] | ValidationError {
  if (raw === undefined) return "ingest";
  const trimmed = raw.trim();
  if (trimmed === "all") return "all";
  if (ORIGINS.has(trimmed)) return trimmed as ClassificationOrigin;
  return badRequest("invalid origin");
}

function parseBound(
  raw: string | undefined,
  label: string,
): { ms: number; supplied: boolean } | ValidationError {
  if (raw === undefined) return { ms: Number.NaN, supplied: false };
  const ms = parseTimestamp(raw.trim());
  if (ms === null) return badRequest(`invalid ${label}`);
  return { ms, supplied: true };
}

function parseSourceId(raw: string | undefined): string | undefined | ValidationError {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!SOURCE_ID_RE.test(trimmed)) return badRequest("invalid sourceId");
  return trimmed;
}

function parseToken(raw: string | undefined, label: string): string | undefined | ValidationError {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!TOKEN_RE.test(trimmed)) return badRequest(`invalid ${label}`);
  return trimmed;
}

function parseWindow(
  input: ClassificationQueryInput,
  now: number,
): ValidatedWindow | ValidationError {
  const origin = parseOrigin(input.origin);
  if (origin instanceof ValidationError) return origin;
  const after = parseBound(input.after, "after");
  if (after instanceof ValidationError) return after;
  const before = parseBound(input.before, "before");
  if (before instanceof ValidationError) return before;
  const sourceId = parseSourceId(input.sourceId);
  if (sourceId instanceof ValidationError) return sourceId;

  const afterMs = after.supplied ? after.ms : now - DEFAULT_RANGE_MS;
  const beforeMs = before.supplied ? before.ms : now;
  if (afterMs >= beforeMs) return badRequest("after must be before before");
  if (beforeMs - afterMs > MAX_RANGE_MS) return badRequest("range exceeds 100 days");

  return {
    afterMs,
    beforeMs,
    afterIso: new Date(afterMs).toISOString(),
    beforeIso: new Date(beforeMs).toISOString(),
    afterSupplied: after.supplied,
    beforeSupplied: before.supplied,
    origin,
    sourceId,
  };
}

export function parseSummaryQuery(
  input: SummaryQueryInput,
  now = Date.now(),
): ValidatedSummary | ValidationError {
  const window = parseWindow(input, now);
  if (window instanceof ValidationError) return window;
  const model = parseToken(input.model, "model");
  if (model instanceof ValidationError) return model;

  let bucket: ClassificationBucket;
  if (input.bucket === undefined) {
    bucket = window.beforeMs - window.afterMs <= HOUR_BUCKET_MAX_MS ? "hour" : "day";
  } else if (BUCKETS.has(input.bucket.trim())) {
    bucket = input.bucket.trim() as ClassificationBucket;
  } else {
    return badRequest("invalid bucket");
  }

  return { ...window, bucket, model };
}

export function parseRecentQuery(
  input: RecentQueryInput,
  now = Date.now(),
): ValidatedRecent | ValidationError {
  const window = parseWindow(input, now);
  if (window instanceof ValidationError) return window;
  const choice = parseToken(input.choice, "choice");
  if (choice instanceof ValidationError) return choice;

  let disposition: ClassificationDisposition | undefined;
  if (input.disposition !== undefined) {
    const trimmed = input.disposition.trim();
    if (!DISPOSITIONS.has(trimmed)) return badRequest("invalid disposition");
    disposition = trimmed as ClassificationDisposition;
  }

  let limit = DEFAULT_RECENT_LIMIT;
  if (input.limit !== undefined) {
    const trimmed = input.limit.trim();
    if (!LIMIT_RE.test(trimmed)) return badRequest("invalid limit");
    limit = Math.min(MAX_RECENT_LIMIT, Math.max(1, Number(trimmed)));
  }

  let beforeMs = window.beforeMs;
  let skipQuery = false;
  if (input.cursor !== undefined) {
    const cursorMs = parseTimestamp(input.cursor.trim());
    if (cursorMs === null) return badRequest("invalid cursor");
    if (cursorMs < beforeMs) beforeMs = cursorMs;
    if (beforeMs <= window.afterMs) skipQuery = true;
  }

  return {
    ...window,
    beforeMs,
    beforeIso: new Date(beforeMs).toISOString(),
    choice,
    disposition,
    limit,
    skipQuery,
  };
}

export function buildSummaryStatements(
  query: ValidatedSummary,
  dataset: string,
): SummaryStatements {
  const from = datasetSql(dataset);
  const where = whereClause(query);
  const interval = intervalSql(query.bucket);
  const bucketExpr = `toStartOfInterval(timestamp, ${interval})`;
  // `if` requires one type. `_sample_interval * double4` is a float, so the
  // empty branch is `0.0`. Group and order time buckets by alias.
  const cost = "SUM(if(double4 >= 0, _sample_interval * double4, 0.0))";
  return {
    totals:
      `SELECT blob10 AS disposition, SUM(_sample_interval) AS samples, ${cost} AS cost_usd ` +
      `FROM ${from} WHERE ${where} GROUP BY blob10 LIMIT 20`,
    series:
      `SELECT ${bucketExpr} AS t, blob10 AS disposition, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} GROUP BY t, blob10 ORDER BY t LIMIT 10000`,
    choices:
      `SELECT blob9 AS choice, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} GROUP BY blob9 ORDER BY samples DESC LIMIT 100`,
    choiceSeries:
      `SELECT ${bucketExpr} AS t, blob9 AS choice, SUM(_sample_interval) AS samples ` +
      `FROM ${from} WHERE ${where} GROUP BY t, blob9 ORDER BY t LIMIT 25000`,
    models:
      `SELECT blob7 AS provider, blob8 AS model, SUM(_sample_interval) AS samples, ${cost} AS cost_usd ` +
      `FROM ${from} WHERE ${where} GROUP BY blob7, blob8 ORDER BY samples DESC LIMIT 200`,
    histogram:
      `SELECT ${histogramColumns("double1", "selected")}, ${histogramColumns("double2", "confidence")} ` +
      `FROM ${from} WHERE ${where}`,
  };
}

export function buildRecentStatement(query: ValidatedRecent, dataset: string): string {
  const limit = query.limit + 1;
  if (!Number.isInteger(limit) || limit < 2 || limit > MAX_RECENT_LIMIT + 1) {
    throw new Error("refusing to interpolate limit");
  }
  const from = datasetSql(dataset);
  const where = whereClause(query);
  return (
    `SELECT timestamp, blob3 AS origin, blob5 AS release_id, blob6 AS source_id, ` +
    `blob7 AS provider, blob8 AS model, blob9 AS choice, ` +
    `double1 AS selected_probability, double2 AS provider_confidence, ` +
    `blob10 AS disposition, blob11 AS reason, blob13 AS failure_category, ` +
    `double4 AS cost_usd, double7 AS duration_ms ` +
    `FROM ${from} WHERE ${where} ORDER BY timestamp DESC LIMIT ${limit}`
  );
}

/** Stable identity of a validated summary. Omitted bounds stay as sentinels so `now` does not bust the cache. */
export function summaryCacheMaterial(query: ValidatedSummary, dataset: string): string {
  return [
    datasetSql(dataset),
    query.origin,
    query.bucket,
    query.model ?? "",
    query.sourceId ?? "",
    query.afterSupplied ? query.afterIso : "-",
    query.beforeSupplied ? query.beforeIso : "-",
  ].join("\n");
}

const CACHE_PREFIX_RE = /^[-a-z0-9:]{1,80}$/;

/** `prefix` is a trusted constant (`classification-summary:v1:`), never request input. */
export async function prefixedSummaryCacheKey(prefix: string, material: string): Promise<string> {
  if (!CACHE_PREFIX_RE.test(prefix)) throw new Error("refusing cache prefix");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

export async function summaryCacheKey(material: string): Promise<string> {
  return prefixedSummaryCacheKey(SUMMARY_CACHE_PREFIX, material);
}

export function readSummaryCache<T extends object = ClassificationSummary>(
  raw: unknown,
  now: number,
): T | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { at?: unknown; body?: T };
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  if (now - entry.at >= SUMMARY_CACHE_TTL_MS) return null;
  if (!entry.body || typeof entry.body !== "object" || !("totals" in entry.body)) return null;
  return entry.body;
}

export function summaryCacheEntry(body: object, now: number): string {
  return JSON.stringify({ at: now, body });
}

function finiteNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function countOf(value: unknown): number {
  const n = finiteNumber(value);
  if (n === null || n < 0) return 0;
  return n;
}

function metricOrNull(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null || n < 0) return null;
  return n;
}

function textOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > 500 ? value.slice(0, 500) : value;
}

export function aeTimestampToIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string") return null;
  const ms = parseTimestamp(value.trim());
  if (ms === null) return null;
  return new Date(ms).toISOString();
}

function isDisposition(value: unknown): value is ClassificationDisposition {
  return typeof value === "string" && DISPOSITIONS.has(value);
}

function isOrigin(value: unknown): value is ClassificationOrigin {
  return typeof value === "string" && ORIGINS.has(value);
}

function emptySeriesBucket(t: string): ClassificationSummary["series"][number] {
  return { t, kept: 0, suppressed: 0, failed: 0, skipped: 0 };
}

const BIN_COUNT = 10;

function emptyBins(): ClassificationSummary["probability"]["selected"]["bins"] {
  return Array.from({ length: BIN_COUNT }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    count: 0,
  }));
}

function fillHistogram(
  row: AeRow | undefined,
  prefix: "selected" | "confidence",
): ClassificationSummary["probability"]["selected"] {
  const bins = emptyBins();
  for (let i = 0; i < BIN_COUNT; i++) {
    const bin = bins[i];
    if (bin) bin.count = countOf(row?.[`${prefix}_${i}`]);
  }
  return { bins, missing: countOf(row?.[`${prefix}_missing`]) };
}

export function shapeClassificationSummary(input: {
  afterIso: string;
  beforeIso: string;
  bucket: ClassificationBucket;
  origin: ValidatedWindow["origin"];
  dataset: string;
  totals: AeRow[];
  series: AeRow[];
  choices: AeRow[];
  choiceSeries: AeRow[];
  models: AeRow[];
  histogram: AeRow[];
  /** Current effective threshold (operator override, else the code default).
   *  Falls back to `MARKETING_SUPPRESSION_THRESHOLD` when omitted. */
  effectiveThreshold?: number;
}): ClassificationSummary {
  const totals = { kept: 0, suppressed: 0, failed: 0, skipped: 0, costUsd: 0 };
  for (const row of input.totals) {
    if (!isDisposition(row.disposition)) continue;
    totals[row.disposition] += countOf(row.samples);
    totals.costUsd += countOf(row.cost_usd);
  }
  const classified = totals.kept + totals.suppressed + totals.failed + totals.skipped;
  const denom = totals.kept + totals.suppressed;

  const seriesMap = new Map<string, ClassificationSummary["series"][number]>();
  for (const row of input.series) {
    const t = aeTimestampToIso(row.t);
    if (!t || !isDisposition(row.disposition)) continue;
    const bucket = seriesMap.get(t) ?? emptySeriesBucket(t);
    bucket[row.disposition] += countOf(row.samples);
    seriesMap.set(t, bucket);
  }

  const choices: ClassificationSummary["choices"] = [];
  for (const row of input.choices) {
    const choice = textOf(row.choice).trim();
    if (!choice) continue;
    choices.push({ choice, count: countOf(row.samples) });
  }
  choices.sort((a, b) => b.count - a.count || a.choice.localeCompare(b.choice));

  const choiceSeriesMap = new Map<string, Record<string, number>>();
  for (const row of input.choiceSeries) {
    const t = aeTimestampToIso(row.t);
    const choice = textOf(row.choice).trim();
    if (!t || !choice) continue;
    const bucket = choiceSeriesMap.get(t) ?? {};
    bucket[choice] = (bucket[choice] ?? 0) + countOf(row.samples);
    choiceSeriesMap.set(t, bucket);
  }

  const models: ClassificationSummary["models"] = input.models.map((row) => ({
    provider: textOf(row.provider),
    model: textOf(row.model),
    count: countOf(row.samples),
    costUsd: countOf(row.cost_usd),
  }));
  models.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const histogram = input.histogram[0];
  return {
    after: input.afterIso,
    before: input.beforeIso,
    bucket: input.bucket,
    origin: input.origin,
    totals: {
      classified,
      kept: totals.kept,
      suppressed: totals.suppressed,
      failed: totals.failed,
      skipped: totals.skipped,
      costUsd: totals.costUsd,
      suppressionRate: denom === 0 ? null : totals.suppressed / denom,
    },
    series: [...seriesMap.values()].toSorted((a, b) => a.t.localeCompare(b.t)),
    choices,
    choiceSeries: [...choiceSeriesMap.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([t, choiceCounts]) => ({ t, choices: choiceCounts })),
    models,
    probability: {
      threshold: input.effectiveThreshold ?? MARKETING_SUPPRESSION_THRESHOLD,
      selected: fillHistogram(histogram, "selected"),
      confidence: fillHistogram(histogram, "confidence"),
    },
    meta: {
      dataset: input.dataset,
      retentionDays: CLASSIFICATION_RETENTION_DAYS,
      sampled: true,
    },
  };
}

export interface RecentHydration {
  sources: Map<string, HydratedSource>;
  releases: Map<string, { title: string }>;
}

function shapeRecentRow(row: AeRow, hydration: RecentHydration): ClassificationRecentItem | null {
  const timestamp = aeTimestampToIso(row.timestamp);
  if (!timestamp || !isOrigin(row.origin) || !isDisposition(row.disposition)) return null;
  const sourceId =
    typeof row.source_id === "string" && SOURCE_ID_RE.test(row.source_id) ? row.source_id : null;
  const releaseId =
    typeof row.release_id === "string" && RELEASE_ID_RE.test(row.release_id)
      ? row.release_id
      : null;
  const source = sourceId ? hydration.sources.get(sourceId) : undefined;
  const release = releaseId ? hydration.releases.get(releaseId) : undefined;
  return {
    timestamp,
    origin: row.origin,
    sourceId,
    sourceName: source?.name ?? null,
    sourceSlug: source?.slug ?? null,
    orgSlug: source?.orgSlug ?? null,
    releaseId,
    releaseTitle: release?.title ?? null,
    provider: textOf(row.provider),
    model: textOf(row.model),
    choice: textOf(row.choice),
    selectedChoiceProbability: metricOrNull(row.selected_probability),
    providerConfidence: metricOrNull(row.provider_confidence),
    disposition: row.disposition,
    reason: textOf(row.reason),
    failureCategory: textOf(row.failure_category),
    costUsd: metricOrNull(row.cost_usd),
    durationMs: metricOrNull(row.duration_ms),
  };
}

export function shapeClassificationRecent(
  rows: AeRow[],
  hydration: RecentHydration,
  limit: number,
): ClassificationRecentResponse {
  const hasMore = rows.length > limit;
  const items: ClassificationRecentItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const item = shapeRecentRow(row, hydration);
    if (item) items.push(item);
  }
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.timestamp ?? null) : null,
  };
}

/** Safe operator context. The Analytics Engine body stays in the log. */
function aeQueryError(query: string, status?: number): UpstreamError {
  return new UpstreamError("AE query failed", {
    code: "ae_query_failed",
    details: status === undefined ? { query } : { query, status },
  });
}

async function queryAe(
  creds: { apiToken: string; accountId: string },
  sql: string,
  fetchImpl: typeof fetch,
  queryName: string,
): Promise<AeRow[] | UpstreamError> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId)}/analytics_engine/sql`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiToken}` },
      body: sql,
    });
  } catch {
    logEvent("warn", {
      component: "classification-analytics",
      event: "ae-query-failed",
      query: queryName,
    });
    return aeQueryError(queryName);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
    logEvent("warn", {
      component: "classification-analytics",
      event: "ae-query-failed",
      query: queryName,
      status: res.status,
      detail,
    });
    return aeQueryError(queryName, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return aeQueryError(queryName, res.status);
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return aeQueryError(queryName, res.status);
  }
  return data as AeRow[];
}

async function requireCreds(
  env: AeEnv,
): Promise<{ apiToken: string; accountId: string } | ReleasesError> {
  const creds = await resolveCloudflareAeCredentials(env);
  if (!creds) {
    return new ServiceUnavailableError("Cloudflare Analytics credentials are not configured", {
      code: "deliveries_unavailable",
    });
  }
  return creds;
}

/**
 * Run named Analytics Engine statements with the shared classifications
 * credentials. Statement names land in `ae_query_failed` details — keep them
 * short and free of SQL. A missing credential is `deliveries_unavailable`.
 */
export async function queryClassificationDataset<T extends Record<keyof T, string>>(
  env: AeEnv,
  statements: T,
  fetchImpl: typeof fetch = fetch,
): Promise<{ [K in keyof T]: AeRow[] } | ReleasesError> {
  const creds = await requireCreds(env);
  if (creds instanceof ReleasesError) return creds;
  const keys = Object.keys(statements) as (keyof T & string)[];
  const results = await Promise.all(
    keys.map((key) => queryAe(creds, statements[key], fetchImpl, key)),
  );
  const failed = results.find((result) => result instanceof ReleasesError);
  if (failed instanceof ReleasesError) return failed;
  return Object.fromEntries(keys.map((key, i) => [key, results[i]])) as {
    [K in keyof T]: AeRow[];
  };
}

export async function fetchClassificationSummary(
  env: AeEnv,
  query: ValidatedSummary,
  fetchImpl: typeof fetch = fetch,
): Promise<ClassificationSummary | ReleasesError> {
  const dataset = classificationDatasetName(env.ENVIRONMENT);
  const [rows, effectiveThreshold] = await Promise.all([
    queryClassificationDataset(env, buildSummaryStatements(query, dataset), fetchImpl),
    loadMarketingThreshold(env.DB),
  ]);
  if (rows instanceof ReleasesError) return rows;
  return shapeClassificationSummary({
    afterIso: query.afterIso,
    beforeIso: query.beforeIso,
    bucket: query.bucket,
    origin: query.origin,
    dataset,
    totals: rows.totals ?? [],
    series: rows.series ?? [],
    choices: rows.choices ?? [],
    choiceSeries: rows.choiceSeries ?? [],
    models: rows.models ?? [],
    histogram: rows.histogram ?? [],
    effectiveThreshold,
  });
}

async function hydrateRecent(db: any, items: ClassificationRecentItem[]): Promise<RecentHydration> {
  const sourceIds = [
    ...new Set(items.map((item) => item.sourceId).filter((id): id is string => id !== null)),
  ];
  const releaseIds = [
    ...new Set(items.map((item) => item.releaseId).filter((id): id is string => id !== null)),
  ];
  const sourcesMap = new Map<string, HydratedSource>();
  const releasesMap = new Map<string, { title: string }>();
  const sourceGroups = await Promise.all(
    chunkArray(sourceIds, IN_ARRAY_CHUNK_SIZE).map((ids) =>
      db
        .select({
          id: sources.id,
          name: sources.name,
          slug: sources.slug,
          orgSlug: organizations.slug,
        })
        .from(sources)
        .leftJoin(organizations, eq(sources.orgId, organizations.id))
        .where(inArray(sources.id, ids)),
    ),
  );
  for (const group of sourceGroups) {
    for (const row of group as Array<{
      id: string;
      name: string;
      slug: string;
      orgSlug: string | null;
    }>) {
      sourcesMap.set(row.id, { name: row.name, slug: row.slug, orgSlug: row.orgSlug ?? null });
    }
  }
  const releaseGroups = await Promise.all(
    chunkArray(releaseIds, IN_ARRAY_CHUNK_SIZE).map((ids) =>
      db
        .select({ id: releases.id, title: releases.title })
        .from(releases)
        .where(inArray(releases.id, ids)),
    ),
  );
  for (const group of releaseGroups) {
    for (const row of group as Array<{ id: string; title: string }>) {
      releasesMap.set(row.id, { title: row.title });
    }
  }
  return { sources: sourcesMap, releases: releasesMap };
}

export async function fetchClassificationRecent(
  env: AeEnv,
  db: any,
  query: ValidatedRecent,
  fetchImpl: typeof fetch = fetch,
): Promise<ClassificationRecentResponse | ReleasesError> {
  const creds = await requireCreds(env);
  if (creds instanceof ReleasesError) return creds;
  if (query.skipQuery) return { items: [], nextCursor: null };
  const dataset = classificationDatasetName(env.ENVIRONMENT);
  const rows = await queryAe(creds, buildRecentStatement(query, dataset), fetchImpl, "recent");
  if (rows instanceof ReleasesError) return rows;
  // Shape once without display fields so the lookup list is the page, not the extra cursor row.
  const unhydrated = shapeClassificationRecent(
    rows,
    { sources: new Map(), releases: new Map() },
    query.limit,
  );
  const hydration = await hydrateRecent(db, unhydrated.items);
  return shapeClassificationRecent(rows, hydration, query.limit);
}
