import { test, expect } from "bun:test";
import {
  preflightDecision,
  selectNewUrls,
  applyCap,
  budgetGate,
  cleanVersion,
  dedupeRecords,
  chunk,
  finalStatus,
  summaryPath,
  sweepReportPath,
} from "./backfill-helpers.js";

test("preflightDecision: proceed/refuse/unknown-with-retry", () => {
  expect(preflightDecision("proceed", 1)).toEqual({ action: "proceed" });
  expect(preflightDecision("refuse", 1)).toEqual({ action: "stop", status: "refused" });
  expect(preflightDecision("unknown", 1)).toEqual({ action: "retry" });
  expect(preflightDecision("unknown", 2)).toEqual({ action: "stop", status: "blocked-unknown" });
});

test("selectNewUrls: drops already-ingested and intra-list dupes, preserves order", () => {
  const r = selectNewUrls(["a", "b", "a", "c"], ["b"]);
  expect(r.fresh).toEqual(["a", "c"]);
  expect(r.skippedKnown).toBe(1);
});

test("applyCap: caps and reports skipped with a log line", () => {
  const r = applyCap(["a", "b", "c"], 2);
  expect(r.targets).toEqual(["a", "b"]);
  expect(r.capped).toBe(2);
  expect(r.deferred).toBe(1);
  expect(r.logLine).toContain("skipping 1");
  const none = applyCap(["a"], 50);
  expect(none.deferred).toBe(0);
  expect(none.logLine).toContain("within cap");
});

test("budgetGate: no ceiling never stops; stops under reserve", () => {
  expect(budgetGate(null, 0, 1000, 0, 10)).toEqual({ stop: false });
  expect(budgetGate(500000, 999999, 60000, 8, 40).stop).toBe(false);
  const g = budgetGate(500000, 100, 60000, 8, 40);
  expect(g.stop).toBe(true);
  expect(g.logLine).toContain("32 pages deferred");
});

test("cleanVersion: strips placeholders, trims, keeps real versions", () => {
  expect(cleanVersion("<UNKNOWN>")).toBeUndefined();
  expect(cleanVersion("n/a")).toBeUndefined();
  expect(cleanVersion("  ")).toBeUndefined();
  expect(cleanVersion(null)).toBeUndefined();
  expect(cleanVersion(" 1.4.0 ")).toBe("1.4.0");
});

test("dedupeRecords: dedups by url, drops missing/blank fields, trims + cleans", () => {
  const { kept, dropped, reasons } = dedupeRecords([
    { url: "u1", title: "T", content: "C", version: "<UNKNOWN>" },
    { url: "u1", title: "T2", content: "C2" }, // dup url
    { url: "u2", title: "", content: "C" }, // missing title
    { title: "T3", content: "C3" }, // missing url
    { url: "u3", title: "T3", content: "C3", version: "2.0" },
    { url: "u4", title: "   ", content: "C4" }, // whitespace-only title -> dropped
    { url: "u5", title: " Spaced ", content: " body " }, // trimmed on store
  ]);
  expect(kept.map((r) => r.url)).toEqual(["u1", "u3", "u5"]);
  expect(kept[0].version).toBeUndefined();
  expect(kept[1].version).toBe("2.0");
  expect(kept[2].title).toBe("Spaced");
  expect(kept[2].content).toBe("body");
  expect(dropped).toBe(4);
  expect(reasons).toEqual({ missingUrl: 1, missingTitleOrContent: 2, duplicate: 1 });
});

test("chunk: splits into bounded groups", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 2)).toEqual([]);
});

test("finalStatus: partial-budget when anything deferred", () => {
  expect(finalStatus(0)).toBe("completed");
  expect(finalStatus(3)).toBe("partial-budget");
});

test("summaryPath: canonical standalone, slug-namespaced under a sweep, null run dir → null", () => {
  const dir = "/home/u/.releases/work/runs/2026-06-04-0944-backfill-inngest";
  expect(summaryPath(dir, "inngest", false)).toBe(dir + "/summary.md");
  // Under a sweep, siblings share one dir → each summary is namespaced (no clobber).
  expect(summaryPath(dir, "inngest", true)).toBe(dir + "/summary-inngest.md");
  expect(summaryPath(null, "inngest", true)).toBeNull();
});

test("sweepReportPath: runs/<ts>-batch → sibling reports/<date>-backfill-sweep.md", () => {
  expect(sweepReportPath("/home/u/.releases/work/runs/2026-06-04-0944-backfill-sweep")).toBe(
    "/home/u/.releases/work/reports/2026-06-04-backfill-sweep.md",
  );
  // Honors a custom RELEASES_DATA_DIR root (only the trailing /runs/<name> is rewritten).
  expect(sweepReportPath("/data/work/runs/2026-01-09-2312-backfill-sweep")).toBe(
    "/data/work/reports/2026-01-09-backfill-sweep.md",
  );
  expect(sweepReportPath(null)).toBeNull();
});
