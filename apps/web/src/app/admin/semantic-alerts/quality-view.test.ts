import { describe, expect, it } from "bun:test";
import type { SemanticAlertSummary } from "@buildinternet/releases-api-types";
import {
  formatMatchRate,
  formatQualityBucket,
  readSemanticAlertSummary,
  SEMANTIC_ALERT_DAILY_SPEND_APL,
  SEMANTIC_ALERT_WEEKLY_SPEND_APL,
  semanticAlertFailureNote,
  semanticAlertQualityState,
  semanticAlertQualityWindow,
  semanticAlertSummaryUrl,
} from "./quality-view";

const NOW = new Date("2026-09-21T18:30:00.000Z");

function summary(overrides: Partial<SemanticAlertSummary> = {}): SemanticAlertSummary {
  return {
    after: "2026-09-14T00:00:00.000Z",
    before: "2026-09-21T00:00:00.000Z",
    bucket: "day",
    totals: { scored: 10, matched: 8, belowThreshold: 2, failed: 1, matchRate: 0.8 },
    series: [],
    failures: [],
    probability: {
      defaultThreshold: 0.8,
      bins: [{ start: 0.8, end: 0.9, count: 8 }],
      missing: 0,
    },
    meta: {
      dataset: "release_classifications",
      retentionDays: 90,
      sampled: true,
      costLane: "semantic-alert-match",
    },
    ...overrides,
  };
}

describe("semantic alert quality window", () => {
  it("uses hour buckets for 24h and day buckets for 7d and 30d", () => {
    const day = semanticAlertQualityWindow("day", NOW);
    expect(day.bucket).toBe("hour");
    expect(Date.parse(day.before) - Date.parse(day.after)).toBe(24 * 60 * 60 * 1000);

    const week = semanticAlertQualityWindow("week", NOW);
    expect(week.bucket).toBe("day");
    expect(Date.parse(week.before) - Date.parse(week.after)).toBe(7 * 24 * 60 * 60 * 1000);

    const month = semanticAlertQualityWindow("month", NOW);
    expect(month.bucket).toBe("day");
    const url = semanticAlertSummaryUrl(week);
    expect(url.startsWith("/api/proxy/admin/semantic-alerts/summary?")).toBe(true);
    expect(url).toContain("bucket=day");
    expect(url).toContain(`after=${encodeURIComponent(week.after)}`);
  });

  it("treats a zero attempt count as empty and a null rate as an em dash", () => {
    expect(semanticAlertQualityState({ loading: true, error: false, attempts: 4 })).toBe("loading");
    expect(semanticAlertQualityState({ loading: false, error: true, attempts: 4 })).toBe("error");
    expect(semanticAlertQualityState({ loading: false, error: false, attempts: null })).toBe(
      "loading",
    );
    expect(semanticAlertQualityState({ loading: false, error: false, attempts: 0 })).toBe("empty");
    expect(semanticAlertQualityState({ loading: false, error: false, attempts: 3 })).toBe("ready");
    expect(formatMatchRate(0.8)).toBe("80%");
    expect(formatMatchRate(2 / 3)).toBe("66.7%");
    expect(formatMatchRate(null)).toBe("—");
    expect(formatQualityBucket("2026-09-20T00:00:00.000Z", "day")).toBe("Sep 20");
  });

  it("rejects a payload that is missing totals and names an AE statement failure", () => {
    expect(readSemanticAlertSummary(summary())).not.toBeNull();
    expect(readSemanticAlertSummary({ totals: { scored: 1 } })).toBeNull();
    expect(readSemanticAlertSummary({ ...summary(), meta: { costLane: "marketing" } })).toBeNull();
    expect(
      semanticAlertFailureNote({
        error: { code: "ae_query_failed", details: { query: "failures", status: 502 } },
      }),
    ).toBe("Analytics Engine rejected the failures query (502).");
    expect(
      semanticAlertFailureNote({
        error: { code: "ae_query_failed", details: { query: "select * from alerts" } },
      }),
    ).toBeNull();
  });

  it("keeps the spend queries on the semantic-alert-match lane and off alert text", () => {
    expect(SEMANTIC_ALERT_DAILY_SPEND_APL).toContain("semantic-alert-match");
    expect(SEMANTIC_ALERT_DAILY_SPEND_APL).toContain("costUsd = sum(cost)");
    expect(SEMANTIC_ALERT_DAILY_SPEND_APL).toContain("bin(_time, 1d)");
    expect(SEMANTIC_ALERT_WEEKLY_SPEND_APL).toContain("bin(_time, 7d)");
    expect(SEMANTIC_ALERT_WEEKLY_SPEND_APL).not.toContain("bin(_time, 1d)");
    expect(SEMANTIC_ALERT_DAILY_SPEND_APL).not.toContain("alert.query");
  });
});
