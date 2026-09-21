import { describe, expect, it } from "bun:test";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import {
  CLASSIFICATIONS_EMPTY_COPY,
  CLASSIFICATIONS_ERROR_COPY,
  classificationFailureNote,
  DEFAULT_CLASSIFICATION_ORIGIN,
  classificationRecentUrl,
  classificationSummaryUrl,
  classificationViewState,
  classificationWindow,
  decisionReason,
  formatProbability,
  formatSuppressionRate,
  releaseHref,
  sourceHref,
  thresholdBinIndex,
} from "./classifications-view";

const NOW = new Date("2026-09-21T18:30:00.000Z");
const WEEK_AFTER = "2026-09-15T07:00:00.000Z";

describe("classification window", () => {
  it("clamps all-time to 90 days with day buckets and uses hour buckets for a week", () => {
    const all = classificationWindow({ dateRange: "all", after: null, now: NOW });
    expect(all.bucket).toBe("day");
    expect(all.before).toBe(NOW.toISOString());
    expect(Date.parse(all.before) - Date.parse(all.after)).toBe(90 * 24 * 60 * 60 * 1000);

    const week = classificationWindow({ dateRange: "week", after: WEEK_AFTER, now: NOW });
    expect(week.bucket).toBe("hour");
    expect(week.after).toBe(WEEK_AFTER);

    expect(classificationWindow({ dateRange: "today", after: WEEK_AFTER, now: NOW }).bucket).toBe(
      "hour",
    );
    expect(classificationWindow({ dateRange: "month", after: WEEK_AFTER, now: NOW }).bucket).toBe(
      "day",
    );

    const allUrl = classificationSummaryUrl(all, DEFAULT_CLASSIFICATION_ORIGIN);
    expect(allUrl.startsWith("/api/proxy/admin/classifications/summary?")).toBe(true);
    expect(allUrl).toContain("bucket=day");
    expect(allUrl).toContain(`after=${encodeURIComponent(all.after)}`);
    expect(allUrl).not.toContain("after=null");
    expect(classificationSummaryUrl(week, "ingest")).toContain("bucket=hour");

    const recent = classificationRecentUrl(week, "manual");
    expect(recent).toContain("origin=manual");
    expect(recent).toContain("limit=50");
    expect(recent).not.toContain("bucket=");
    expect(classificationRecentUrl(week, "ingest", { cursor: "abc" })).toContain("cursor=abc");
  });
});

it("defaults the origin filter to ingest", () => {
  expect(DEFAULT_CLASSIFICATION_ORIGIN).toBe("ingest");
});

describe("summary view state", () => {
  it("is loading, empty when classified is 0, error, or ready", () => {
    expect(classificationViewState({ loading: true, error: false, classified: null })).toBe(
      "loading",
    );
    expect(classificationViewState({ loading: false, error: false, classified: 0 })).toBe("empty");
    expect(classificationViewState({ loading: false, error: true, classified: 0 })).toBe("error");
    expect(classificationViewState({ loading: true, error: true, classified: 4 })).toBe("error");
    expect(classificationViewState({ loading: false, error: false, classified: 4 })).toBe("ready");
  });
});

it("formats a null suppression rate as an em dash and any other rate as a percent", () => {
  expect(formatSuppressionRate(null)).toBe("—");
  expect(formatSuppressionRate(0)).toBe("0%");
  expect(formatSuppressionRate(0.125)).toBe("12.5%");
});

it("formats a null probability as an em dash and 0.8 as a distinct value", () => {
  expect(formatProbability(null)).toBe("—");
  expect(formatProbability(0.8)).toBe("0.80");
  expect(formatProbability(0.8)).not.toBe(formatProbability(null));
});

it("treats the 0.80 threshold as the start of a bin, not inside 0.7–0.8", () => {
  const bins = [
    { start: 0.7, end: 0.8, count: 4 },
    { start: 0.8, end: 0.9, count: 9 },
  ];
  const index = thresholdBinIndex(bins, 0.8);
  expect(bins[index]?.start).toBe(0.8);
  expect(bins[index]?.end).toBe(0.9);
  expect(bins[index]).not.toMatchObject({ start: 0.7, end: 0.8 });
});

it("builds a release href with releasePath only when id and title exist", () => {
  const releaseId = "rel_1234567890abcdefghijk";
  const releaseTitle = "Widget shipped";
  expect(releaseHref({ releaseId, releaseTitle })).toBe(
    releasePath({ id: releaseId, title: releaseTitle }),
  );
  expect(releaseHref({ releaseId: null, releaseTitle })).toBeNull();
  expect(releaseHref({ releaseId, releaseTitle: null })).toBeNull();
});

it("prefers an org/source href over the bare source path", () => {
  expect(sourceHref({ orgSlug: "openai", sourceSlug: "changelog" })).toBe("/openai/changelog");
  expect(sourceHref({ orgSlug: null, sourceSlug: "changelog" })).toBe("/source/changelog");
  expect(sourceHref({ orgSlug: "openai", sourceSlug: null })).toBeNull();
});

it("uses the empty and error copy shown on the tab", () => {
  expect(CLASSIFICATIONS_EMPTY_COPY).toBe("No classifications in this range.");
  expect(CLASSIFICATIONS_ERROR_COPY).toBe(
    "Classifications failed to load. The rest of Status is unaffected.",
  );
});

it("names the failed Analytics Engine statement without echoing its body", () => {
  expect(
    classificationFailureNote({
      error: {
        code: "ae_query_failed",
        type: "upstream",
        message: "Upstream service error",
        details: { query: "totals", status: 400 },
      },
    }),
  ).toBe("Analytics Engine rejected the totals query (400).");
  expect(
    classificationFailureNote({
      error: {
        code: "ae_query_failed",
        details: { query: "totals", status: 400, detail: "syntax error near secret" },
      },
    }),
  ).toBe("Analytics Engine rejected the totals query (400).");
  expect(
    classificationFailureNote({
      error: { code: "ae_query_failed", details: { query: "drop table" } },
    }),
  ).toBeNull();
});

it("falls back to failureCategory when the reason is empty", () => {
  expect(decisionReason({ reason: " ", failureCategory: "timeout" })).toBe("timeout");
  expect(decisionReason({ reason: "below-threshold", failureCategory: "timeout" })).toBe(
    "below-threshold",
  );
  expect(decisionReason({ reason: null, failureCategory: null })).toBe("—");
});
