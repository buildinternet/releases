import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SemanticAlertSummarySchema } from "@buildinternet/releases-api-types";
import { ValidationError } from "@releases/lib/releases-error";
import { DATASET_PRODUCTION, DATASET_STAGING } from "./classification-schema.js";
import {
  parseSummaryQuery,
  readSummaryCache,
  summaryCacheEntry,
  type ValidatedSummary,
} from "./classification-query.js";
import { adminSemanticAlertsRoutes } from "../routes/admin-semantic-alerts.js";
import {
  buildSemanticAlertSummaryStatements,
  semanticAlertSummaryCacheKey,
  semanticAlertSummaryCacheMaterial,
  shapeSemanticAlertSummary,
} from "./semantic-alert-summary.js";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const AFTER = "2026-09-14T00:00:00.000Z";
const BEFORE = "2026-09-21T00:00:00.000Z";

function summary(overrides: Record<string, string> = {}): ValidatedSummary {
  const parsed = parseSummaryQuery({ after: AFTER, before: BEFORE, ...overrides }, NOW);
  if (parsed instanceof ValidationError) throw new Error(parsed.message);
  return parsed;
}

function sql(query: ValidatedSummary = summary(), dataset = DATASET_PRODUCTION): string {
  return Object.values(buildSemanticAlertSummaryStatements(query, dataset)).join("\n");
}

describe("semantic-alert summary SQL", () => {
  it("filters semantic-alert points, weights samples, and leaves cost off the point", () => {
    const text = sql();
    expect(text).toContain("blob1 = '1'");
    expect(text).toContain("blob4 = 'semantic-alert'");
    expect(text).toContain("blob3 = 'ingest'");
    expect(text).toContain("SUM(_sample_interval)");
    expect(text).toContain("SUM(if(double1 < 0, _sample_interval, 0)) AS selected_missing");
    expect(text).toContain("(double1 >= 0.8) AND (double1 < 0.9)");
    expect(text).toContain("(double1 >= 0.9) AND (double1 <= 1.0)");
    expect(text).toContain("blob10 = 'failed'");
    expect(text).not.toContain("blob4 = 'marketing'");
    expect(text).not.toContain("double4");
    expect(text).not.toContain("blob11");
    expect(text).not.toContain("query");
    expect(text).not.toContain("COUNT(");
  });

  it("pins the dataset and refuses an injected identifier or bucket", () => {
    expect(sql()).toContain("FROM release_classifications ");
    expect(buildSemanticAlertSummaryStatements(summary(), DATASET_STAGING).totals).toContain(
      "FROM release_classifications_staging ",
    );
    expect(() =>
      buildSemanticAlertSummaryStatements(summary(), "release_classifications; DROP"),
    ).toThrow(/dataset/);
    expect(() =>
      buildSemanticAlertSummaryStatements(
        { ...summary(), bucket: "week" } as unknown as ValidatedSummary,
        DATASET_PRODUCTION,
      ),
    ).toThrow(/bucket/);
    expect(parseSummaryQuery({ bucket: "week", after: AFTER, before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
    expect(parseSummaryQuery({ after: "yesterday", before: BEFORE }, NOW)).toBeInstanceOf(
      ValidationError,
    );
  });

  it("drops the origin predicate only when origin is all", () => {
    expect(sql(summary({ origin: "all" }))).not.toContain("blob3");
  });
});

describe("semantic-alert summary shaping", () => {
  it("computes match rate from scored rows and keeps failures out of the denominator", () => {
    const shaped = shapeSemanticAlertSummary({
      afterIso: AFTER,
      beforeIso: BEFORE,
      bucket: "day",
      dataset: DATASET_PRODUCTION,
      totals: [
        { disposition: "matched", samples: 8 },
        { disposition: "below_threshold", samples: "2" },
        { disposition: "failed", samples: 5 },
        { disposition: "kept", samples: 100 },
      ],
      series: [
        { t: "2026-09-20 00:00:00", disposition: "matched", samples: 3 },
        { t: "2026-09-20 00:00:00", disposition: "below_threshold", samples: 1 },
        { t: "2026-09-19 00:00:00", disposition: "failed", samples: 4 },
        { t: "not-a-time", disposition: "matched", samples: 9 },
      ],
      histogram: [{ selected_8: 6, selected_9: 2, selected_missing: 5, selected_0: -1 }],
      failures: [
        { category: "provider_error", samples: 3 },
        { category: "nope", samples: 1 },
        { category: "invalid_probability", samples: 1 },
        { category: "", samples: 0 },
      ],
    });

    expect(shaped.totals).toEqual({
      scored: 10,
      matched: 8,
      belowThreshold: 2,
      failed: 5,
      matchRate: 0.8,
    });
    expect(shaped.series.map((point) => point.t)).toEqual([
      "2026-09-19T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    ]);
    expect(shaped.series[1]).toMatchObject({ matched: 3, belowThreshold: 1, failed: 0 });
    expect(shaped.probability.bins).toHaveLength(10);
    expect(shaped.probability.bins[8]).toEqual({ start: 0.8, end: 0.9, count: 6 });
    expect(shaped.probability.bins[0]?.count).toBe(0);
    expect(shaped.probability.missing).toBe(5);
    expect(shaped.probability.defaultThreshold).toBe(0.8);
    expect(shaped.failures).toEqual([
      { category: "provider_error", count: 3 },
      { category: "invalid_probability", count: 1 },
      { category: "unknown", count: 1 },
    ]);
    expect(shaped.meta).toEqual({
      dataset: DATASET_PRODUCTION,
      retentionDays: 90,
      sampled: true,
      costLane: "semantic-alert-match",
    });
    expect(JSON.stringify(shaped)).not.toContain("slack");
    expect(SemanticAlertSummarySchema.parse(shaped).totals.matchRate).toBe(0.8);
  });

  it("returns a null match rate when every decision failed closed", () => {
    const shaped = shapeSemanticAlertSummary({
      afterIso: AFTER,
      beforeIso: BEFORE,
      bucket: "hour",
      dataset: DATASET_PRODUCTION,
      totals: [{ disposition: "failed", samples: 4 }],
      series: [],
      histogram: [],
      failures: [],
    });
    expect(shaped.totals.scored).toBe(0);
    expect(shaped.totals.matchRate).toBeNull();
    expect(shaped.totals.failed).toBe(4);
    expect(shaped.probability.bins).toHaveLength(10);
    expect(SemanticAlertSummarySchema.parse(shaped).totals.matchRate).toBeNull();
  });

  it("hashes a semantic-alert cache key that marketing summaries cannot share", async () => {
    const parsed = summary();
    const material = semanticAlertSummaryCacheMaterial(parsed, DATASET_PRODUCTION);
    expect(material.startsWith("semantic-alert\n")).toBe(true);
    const key = await semanticAlertSummaryCacheKey(material);
    expect(key.startsWith("semantic-alert-summary:v1:")).toBe(true);
    expect(key).not.toContain("semantic-alert-match");
    const stored = JSON.parse(
      summaryCacheEntry(
        shapeSemanticAlertSummary({
          afterIso: AFTER,
          beforeIso: BEFORE,
          bucket: "day",
          dataset: DATASET_PRODUCTION,
          totals: [],
          series: [],
          histogram: [],
          failures: [],
        }),
        1_000,
      ),
    );
    expect(readSummaryCache(stored, 1_000 + 44_000)?.totals).toBeDefined();
    expect(readSummaryCache(stored, 1_000 + 45_000)).toBeNull();
  });
});

type AeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function summaryApp(fetchImpl: AeFetch) {
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    (c as any).set("aeFetch", fetchImpl);
    await next();
  });
  hono.route("/", adminSemanticAlertsRoutes);
  return hono;
}

describe("GET /admin/semantic-alerts/summary", () => {
  const TOKEN = "super-secret-token";

  function creds(extra: Record<string, unknown> = {}) {
    return {
      CLOUDFLARE_API_TOKEN: { get: async () => TOKEN },
      CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct_123" },
      ENVIRONMENT: "production",
      ...extra,
    };
  }

  it("rejects a bad window before calling Analytics Engine", async () => {
    let called = false;
    const res = await summaryApp(async () => {
      called = true;
      return new Response("nope");
    }).request("/admin/semantic-alerts/summary?after=yesterday", undefined, creds());
    expect(res.status).toBe(400);
    expect(called).toBe(false);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("returns match rate from semantic-alert statements and never sends the token in the body", async () => {
    const calls: string[] = [];
    const fetchImpl: AeFetch = async (input, init) => {
      const statement = String(init?.body ?? "");
      calls.push(statement);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(String(input)).toContain("/accounts/acct_123/analytics_engine/sql");
      expect(statement).not.toContain(TOKEN);
      if (statement.includes("blob13 AS category")) {
        return Response.json({ data: [{ category: "provider_error", samples: 1 }] });
      }
      if (statement.includes("AS selected_0")) {
        return Response.json({ data: [{ selected_8: 7, selected_9: 1, selected_missing: 1 }] });
      }
      if (statement.includes("toStartOfInterval")) {
        return Response.json({
          data: [{ t: "2026-09-20 00:00:00", disposition: "matched", samples: 8 }],
        });
      }
      return Response.json({
        data: [
          { disposition: "matched", samples: 8 },
          { disposition: "below_threshold", samples: 2 },
          { disposition: "failed", samples: 1 },
        ],
      });
    };

    const res = await summaryApp(fetchImpl).request(
      `/admin/semantic-alerts/summary?after=${encodeURIComponent(AFTER)}&before=${encodeURIComponent(BEFORE)}&bucket=day`,
      undefined,
      creds(),
    );
    expect(res.status).toBe(200);
    const body = SemanticAlertSummarySchema.parse(await res.json());
    expect(body.totals).toMatchObject({ scored: 10, matched: 8, failed: 1, matchRate: 0.8 });
    expect(body.failures).toEqual([{ category: "provider_error", count: 1 }]);
    expect(body.meta.costLane).toBe("semantic-alert-match");
    expect(calls.length).toBe(4);
    for (const statement of calls) {
      expect(statement).toContain("blob4 = 'semantic-alert'");
      expect(statement).not.toContain("blob4 = 'marketing'");
    }
  });
});
