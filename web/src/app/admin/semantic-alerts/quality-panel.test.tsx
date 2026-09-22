import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SemanticAlertSummary } from "@buildinternet/releases-api-types";
import {
  SemanticAlertQualityPanel,
  SemanticAlertQualityReport,
  SemanticAlertSpendNote,
} from "./quality-panel.tsx";

function summary(): SemanticAlertSummary {
  return {
    after: "2026-09-14T00:00:00.000Z",
    before: "2026-09-21T00:00:00.000Z",
    bucket: "day",
    totals: { scored: 10, matched: 8, belowThreshold: 2, failed: 1, matchRate: 0.8 },
    series: [{ t: "2026-09-20T00:00:00.000Z", matched: 8, belowThreshold: 2, failed: 1 }],
    failures: [{ category: "provider_error", count: 1 }],
    probability: {
      defaultThreshold: 0.8,
      bins: Array.from({ length: 10 }, (_, i) => ({
        start: i / 10,
        end: (i + 1) / 10,
        count: i === 8 ? 8 : 0,
      })),
      missing: 1,
    },
    meta: {
      dataset: "release_classifications",
      retentionDays: 90,
      sampled: true,
      costLane: "semantic-alert-match",
    },
  };
}

describe("SemanticAlertQualityReport", () => {
  it("shows match rate and fail-closed counts without alert query text", () => {
    const html = renderToStaticMarkup(<SemanticAlertQualityReport summary={summary()} />);
    expect(html).toContain("80%");
    expect(html).toContain("Fail-closed");
    expect(html).toContain("Below threshold");
    expect(html).toContain("provider_error");
    expect(html).toContain("P(true) vs 0.80 default");
    expect(html).toContain("1 missing probability");
    expect(html).not.toContain("slack");
  });
});

describe("SemanticAlertQualityPanel", () => {
  it("loads match quality and shows how to check JEV spend", () => {
    const html = renderToStaticMarkup(
      <>
        <SemanticAlertQualityPanel />
        <SemanticAlertSpendNote />
      </>,
    );
    expect(html).toContain("Loading match quality");
    expect(html).toContain("Fail-closed skips notify");
    expect(html).toContain("semantic-alert-match");
    expect(html).toContain("costUsd");
    expect(html).toContain("bin(_time, 1d)");
    expect(html).toContain("bin(_time, 7d)");
    expect(html).toContain("Alert query text is not on the event");
  });
});
