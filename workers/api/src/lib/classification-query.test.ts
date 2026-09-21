import { describe, expect, it } from "bun:test";
import { ValidationError } from "@releases/lib/releases-error";
import { ClassificationSummarySchema } from "@buildinternet/releases-api-types";
import { DATASET_PRODUCTION, DATASET_STAGING } from "./classification-schema.js";
import {
  buildRecentStatement,
  buildSummaryStatements,
  parseRecentQuery,
  parseSummaryQuery,
  readSummaryCache,
  shapeClassificationRecent,
  shapeClassificationSummary,
  summaryCacheEntry,
  summaryCacheKey,
  summaryCacheMaterial,
  type ValidatedRecent,
  type ValidatedSummary,
} from "./classification-query.js";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const AFTER = "2026-09-14T00:00:00.000Z";
const BEFORE = "2026-09-21T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function summary(overrides: Record<string, string> = {}): ValidatedSummary {
  const parsed = parseSummaryQuery({ after: AFTER, before: BEFORE, ...overrides }, NOW);
  if (parsed instanceof ValidationError) throw new Error(parsed.message);
  return parsed;
}

function recent(overrides: Record<string, string> = {}): ValidatedRecent {
  const parsed = parseRecentQuery({ after: AFTER, before: BEFORE, ...overrides }, NOW);
  if (parsed instanceof ValidationError) throw new Error(parsed.message);
  return parsed;
}

function summarySql(query: ValidatedSummary = summary(), dataset = DATASET_PRODUCTION): string {
  return Object.values(buildSummaryStatements(query, dataset)).join("\n");
}

describe("classification SQL", () => {
  it("weights aggregates by _sample_interval and drops the -1 cost sentinel", () => {
    const sql = summarySql();
    expect(sql).toContain("SUM(_sample_interval)");
    expect(sql).toContain("SUM(if(double4 >= 0, _sample_interval * double4, 0))");
    expect(sql).not.toContain("SUM(double4)");
    expect(sql).not.toContain("COUNT(");
  });

  it("keeps selected probability and provider confidence on different doubles", () => {
    const histogram = buildSummaryStatements(summary(), DATASET_PRODUCTION).histogram;
    const conditions = [...histogram.matchAll(/if\(([^,]+),/g)].map((match) => match[1] ?? "");
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition.includes("double1")).not.toBe(condition.includes("double2"));
    }
    expect(histogram).toContain("double1 >= 0.8 AND double1 < 0.9");
    expect(histogram).toContain("double2 >= 0.8 AND double2 < 0.9");
    expect(histogram).toContain("double1 >= 0.9 AND double1 <= 1.0");
    expect(histogram).toContain("SUM(if(double1 < 0, _sample_interval, 0)) AS selected_missing");
    expect(histogram).toContain("SUM(if(double2 < 0, _sample_interval, 0)) AS confidence_missing");
  });

  it("rejects injected origin and never interpolates it", () => {
    const evil = "ingest' OR 1=1";
    const parsed = parseSummaryQuery({ origin: evil, after: AFTER, before: BEFORE }, NOW);
    expect(parsed).toBeInstanceOf(ValidationError);
    expect((parsed as ValidationError).code).toBe("bad_request");
    expect(JSON.stringify(parsed)).not.toContain("blob3");
    expect(JSON.stringify(parsed)).not.toContain(evil);
    expect(() =>
      buildSummaryStatements(
        { ...summary(), origin: evil } as unknown as ValidatedSummary,
        DATASET_PRODUCTION,
      ),
    ).toThrow(/interpolate/);
    expect(summarySql()).toContain("blob3 = 'ingest'");
    expect(summarySql()).not.toContain(evil);
  });

  it("rejects bad source ids, buckets, limits, cursors, and inverted ranges", () => {
    expect(
      parseSummaryQuery({ sourceId: "src_acme' OR 1=1", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseSummaryQuery({ sourceId: "not-a-source", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseSummaryQuery({ model: "jev'; DROP", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);
    expect(parseSummaryQuery({ bucket: "week", after: AFTER, before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(parseSummaryQuery({ after: "yesterday", before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(parseSummaryQuery({ after: BEFORE, before: AFTER }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(parseSummaryQuery({ after: AFTER, before: AFTER }, NOW)).toBeInstanceOf(ValidationError);

    const start = Date.parse("2026-01-01T00:00:00.000Z");
    expect(
      parseSummaryQuery(
        {
          after: new Date(start).toISOString(),
          before: new Date(start + 100 * DAY_MS + 1).toISOString(),
        },
        NOW,
      ),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseSummaryQuery(
        {
          after: new Date(start).toISOString(),
          before: new Date(start + 100 * DAY_MS).toISOString(),
        },
        NOW,
      ),
    ).not.toBeInstanceOf(ValidationError);

    expect(
      parseRecentQuery({ limit: "1; DROP", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);
    expect(parseRecentQuery({ limit: "1.5", after: AFTER, before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(parseRecentQuery({ limit: "-3", after: AFTER, before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(
      parseRecentQuery(
        { cursor: "2026-09-18T00:00:00.000Z' OR 1=1", after: AFTER, before: BEFORE },
        NOW,
      ),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseRecentQuery({ choice: "case study", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseRecentQuery({ disposition: "hidden", after: AFTER, before: BEFORE }, NOW),
    ).toBeInstanceOf(ValidationError);

    const hi = recent({ limit: "500" });
    expect(hi.limit).toBe(100);
    expect(buildRecentStatement(hi, DATASET_PRODUCTION)).toContain("LIMIT 101");
    expect(recent({ limit: "0" }).limit).toBe(1);
    expect(recent().limit).toBe(50);
  });

  it("defaults omitted origin to ingest and omits the predicate for all", () => {
    const omitted = parseSummaryQuery({ after: AFTER, before: BEFORE }, NOW);
    expect(omitted).not.toBeInstanceOf(ValidationError);
    if (omitted instanceof ValidationError) return;
    expect(omitted.origin).toBe("ingest");
    expect(summarySql(omitted)).toContain("blob3 = 'ingest'");

    const all = summary({ origin: "all" });
    expect(all.origin).toBe("all");
    expect(summarySql(all)).not.toContain("blob3");

    const manual = summary({ origin: "manual" });
    expect(summarySql(manual)).toContain("blob3 = 'manual'");
    expect(summarySql(manual)).not.toContain("blob3 = 'ingest'");
  });

  it("quotes only validated filters and pins the dataset identifier", () => {
    const sql = summarySql(summary({ model: "typesafe/jev-1.13", sourceId: "src_acme" }));
    expect(sql).toContain("blob8 = 'typesafe/jev-1.13'");
    expect(sql).toContain("blob6 = 'src_acme'");
    expect(sql).toContain("blob1 = '1'");
    expect(sql).toContain("blob4 = 'marketing'");
    expect(sql).toContain("FROM release_classifications ");
    expect(buildSummaryStatements(summary(), DATASET_STAGING).totals).toContain(
      "FROM release_classifications_staging ",
    );
    expect(() => buildSummaryStatements(summary(), "release_classifications; DROP")).toThrow(
      /dataset/,
    );
  });

  it("picks hour buckets at 48h and reformats a cursor as an exclusive upper bound", () => {
    const hour = parseSummaryQuery(
      {
        after: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
        before: new Date(NOW).toISOString(),
      },
      NOW,
    );
    expect(hour).not.toBeInstanceOf(ValidationError);
    if (!(hour instanceof ValidationError)) {
      expect(hour.bucket).toBe("hour");
      expect(summarySql(hour)).toContain("INTERVAL '1' HOUR");
    }
    const day = parseSummaryQuery(
      {
        after: new Date(NOW - 48 * 60 * 60 * 1000 - 1).toISOString(),
        before: new Date(NOW).toISOString(),
      },
      NOW,
    );
    expect(day).not.toBeInstanceOf(ValidationError);
    if (!(day instanceof ValidationError)) expect(day.bucket).toBe("day");
    const forced = summary({ bucket: "hour" });
    expect(forced.bucket).toBe("hour");

    const sql = buildRecentStatement(
      recent({ cursor: "2026-09-18T00:00:00.000Z" }),
      DATASET_PRODUCTION,
    );
    expect(sql).toContain("timestamp < toDateTime('2026-09-18 00:00:00')");
    expect(sql).toContain("timestamp >= toDateTime('2026-09-14 00:00:00')");
    expect(sql).not.toContain("2026-09-21 00:00:00");
    expect(sql).not.toContain("_sample_interval");
  });

  it("hashes the validated summary, not the raw query, and expires after 45s", async () => {
    const omitted = summary();
    const explicit = summary({ origin: "ingest" });
    expect(summaryCacheMaterial(omitted, DATASET_PRODUCTION)).toBe(
      summaryCacheMaterial(explicit, DATASET_PRODUCTION),
    );
    expect(summaryCacheMaterial(summary({ origin: "all" }), DATASET_PRODUCTION)).not.toBe(
      summaryCacheMaterial(omitted, DATASET_PRODUCTION),
    );
    const first = parseSummaryQuery({}, NOW);
    const later = parseSummaryQuery({}, NOW + 10_000);
    expect(first).not.toBeInstanceOf(ValidationError);
    expect(later).not.toBeInstanceOf(ValidationError);
    if (!(first instanceof ValidationError) && !(later instanceof ValidationError)) {
      expect(summaryCacheMaterial(first, DATASET_PRODUCTION)).toBe(
        summaryCacheMaterial(later, DATASET_PRODUCTION),
      );
    }
    const key = await summaryCacheKey(summaryCacheMaterial(omitted, DATASET_PRODUCTION));
    expect(key.startsWith("classification-summary:v1:")).toBe(true);
    expect(key).not.toContain("ingest");
    expect(key).not.toContain("typesafe/jev-1.13");

    const body = shapeClassificationSummary({
      afterIso: AFTER,
      beforeIso: BEFORE,
      bucket: "day",
      origin: "ingest",
      dataset: DATASET_PRODUCTION,
      totals: [],
      series: [],
      choices: [],
      choiceSeries: [],
      models: [],
      histogram: [],
    });
    const stored = JSON.parse(summaryCacheEntry(body, 1_000));
    expect(readSummaryCache(stored, 1_000 + 44_000)?.totals.classified).toBe(0);
    expect(readSummaryCache(stored, 1_000 + 45_000)).toBeNull();
    expect(readSummaryCache(body, 1_000)).toBeNull();
  });
});

describe("classification response shaping", () => {
  it("nulls sentinel probabilities, missing rows, an empty suppression rate, and always emits 10 bins", () => {
    const shaped = shapeClassificationSummary({
      afterIso: AFTER,
      beforeIso: BEFORE,
      bucket: "day",
      origin: "ingest",
      dataset: DATASET_PRODUCTION,
      totals: [
        { disposition: "kept", samples: 4, cost_usd: 0 },
        { disposition: "suppressed", samples: 1, cost_usd: 0.05 },
        { disposition: "failed", samples: "2", cost_usd: -1 },
      ],
      series: [
        { t: "2026-09-20 00:00:00", disposition: "kept", samples: 4 },
        { t: "2026-09-20 00:00:00", disposition: "suppressed", samples: 1 },
      ],
      choices: [
        { choice: "", samples: 9 },
        { choice: "case_study", samples: 3 },
      ],
      choiceSeries: [
        { t: "2026-09-20 00:00:00", choice: "", samples: 9 },
        { t: "2026-09-20 00:00:00", choice: "case_study", samples: 3 },
      ],
      models: [{ provider: "openrouter", model: "typesafe/jev-1.13", samples: 5, cost_usd: 0.02 }],
      histogram: [{ selected_8: 5, selected_missing: 2, confidence_3: 4, confidence_missing: 1 }],
    });

    expect(shaped.totals).toEqual({
      classified: 7,
      kept: 4,
      suppressed: 1,
      failed: 2,
      skipped: 0,
      costUsd: 0.05,
      suppressionRate: 0.2,
    });
    expect(shaped.series).toEqual([
      {
        t: "2026-09-20T00:00:00.000Z",
        kept: 4,
        suppressed: 1,
        failed: 0,
        skipped: 0,
      },
    ]);
    expect(shaped.choices).toEqual([{ choice: "case_study", count: 3 }]);
    expect(shaped.choiceSeries).toEqual([
      { t: "2026-09-20T00:00:00.000Z", choices: { case_study: 3 } },
    ]);
    expect(shaped.probability.threshold).toBe(0.8);
    expect(shaped.probability.selected.bins).toHaveLength(10);
    expect(shaped.probability.selected.bins[8]).toEqual({ start: 0.8, end: 0.9, count: 5 });
    expect(shaped.probability.selected.bins[9]).toEqual({ start: 0.9, end: 1, count: 0 });
    expect(shaped.probability.selected.missing).toBe(2);
    expect(shaped.probability.confidence.bins[3]).toEqual({ start: 0.3, end: 0.4, count: 4 });
    expect(shaped.probability.confidence.bins[8]?.count).toBe(0);
    expect(shaped.probability.selected.bins[3]?.count).toBe(0);
    expect(shaped.meta).toEqual({
      dataset: DATASET_PRODUCTION,
      retentionDays: 90,
      sampled: true,
    });
    expect(ClassificationSummarySchema.parse(shaped).probability.selected.bins).toHaveLength(10);

    const noDecisions = shapeClassificationSummary({
      afterIso: AFTER,
      beforeIso: BEFORE,
      bucket: "hour",
      origin: "all",
      dataset: DATASET_PRODUCTION,
      totals: [{ disposition: "failed", samples: 2, cost_usd: 0.01 }],
      series: [],
      choices: [],
      choiceSeries: [],
      models: [],
      histogram: [],
    });
    expect(noDecisions.totals.suppressionRate).toBeNull();
    expect(noDecisions.probability.selected.bins).toHaveLength(10);
    expect(noDecisions.probability.selected.bins.every((bin) => bin.count === 0)).toBe(true);
    expect(noDecisions.probability.selected.missing).toBe(0);
    expect(noDecisions.probability.confidence.bins).toHaveLength(10);
    expect(noDecisions.probability.selected.bins[8]?.start).toBe(0.8);

    const rows = [
      {
        timestamp: "2026-09-21 12:00:00",
        origin: "ingest",
        source_id: "src_acme",
        release_id: "rel_shipped",
        provider: "openrouter",
        model: "typesafe/jev-1.13",
        choice: "case_study",
        selected_probability: -1,
        provider_confidence: 0,
        disposition: "suppressed",
        reason: "case_study",
        failure_category: "",
        cost_usd: -1,
        duration_ms: 12,
      },
      {
        timestamp: "2026-09-21 11:00:00",
        origin: "manual",
        source_id: "src_missing",
        release_id: "rel_missing",
        provider: "openrouter",
        model: "typesafe/jev-1.13",
        choice: "real_product_news",
        selected_probability: 0.91,
        provider_confidence: -1,
        disposition: "kept",
        reason: "",
        failure_category: "",
        cost_usd: 0,
        duration_ms: -1,
      },
      {
        timestamp: "2026-09-21 10:00:00",
        origin: "eval",
        source_id: "",
        release_id: "",
        provider: "anthropic",
        model: "claude",
        choice: "unclear_other",
        selected_probability: 0.2,
        provider_confidence: 0.2,
        disposition: "skipped",
        reason: "cap",
        failure_category: "cap",
        cost_usd: 0,
        duration_ms: 1,
      },
    ];
    const page = shapeClassificationRecent(
      rows,
      {
        sources: new Map([["src_acme", { name: "Acme", slug: "acme-cl", orgSlug: "acme" }]]),
        releases: new Map([["rel_shipped", { title: "Widgets" }]]),
      },
      2,
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe("2026-09-21T11:00:00.000Z");
    expect(page.items[0]).toMatchObject({
      sourceId: "src_acme",
      sourceName: "Acme",
      sourceSlug: "acme-cl",
      orgSlug: "acme",
      releaseId: "rel_shipped",
      releaseTitle: "Widgets",
      selectedChoiceProbability: null,
      providerConfidence: 0,
      costUsd: null,
      durationMs: 12,
    });
    expect(page.items[1]).toMatchObject({
      sourceId: "src_missing",
      sourceName: null,
      sourceSlug: null,
      orgSlug: null,
      releaseId: "rel_missing",
      releaseTitle: null,
      selectedChoiceProbability: 0.91,
      providerConfidence: null,
      costUsd: 0,
      durationMs: null,
    });
  });
});
