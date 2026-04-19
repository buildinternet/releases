import { describe, it, expect } from "bun:test";
import { formatCronReport, type CronReport } from "../../workers/api/src/lib/cron-report";

const baseReport: CronReport = {
  cronName: "scrape-agent-sweep",
  runId: "cron_run_01",
  status: "done",
  startedAt: "2026-04-19T01:00:00.000Z",
  endedAt: "2026-04-19T01:00:12.500Z",
  durationMs: 12500,
  candidates: 3,
  dispatched: 3,
  skippedOverCap: 0,
  dispatchErrors: 0,
};

describe("formatCronReport", () => {
  it("subject has no severity prefix when status is done", () => {
    const { subject } = formatCronReport(baseReport);
    expect(subject).toBe("scrape-agent-sweep: done — 3/3 dispatched");
  });

  it("prefixes subject with [failed] when dispatch_failed", () => {
    const { subject } = formatCronReport({ ...baseReport, status: "dispatch_failed", dispatched: 0, dispatchErrors: 3 });
    expect(subject.startsWith("[failed] ")).toBe(true);
  });

  it("prefixes subject with [degraded] when degraded", () => {
    const { subject } = formatCronReport({ ...baseReport, status: "degraded", dispatched: 2, dispatchErrors: 1 });
    expect(subject.startsWith("[degraded] ")).toBe(true);
  });

  it("prefixes subject with [aborted] when aborted", () => {
    const { subject } = formatCronReport({ ...baseReport, status: "aborted", abortReason: "anthropic_credits" });
    expect(subject.startsWith("[aborted] ")).toBe(true);
  });

  it("text body includes run metadata and counters", () => {
    const { text } = formatCronReport(baseReport);
    expect(text).toContain("Cron: scrape-agent-sweep");
    expect(text).toContain("Run: cron_run_01");
    expect(text).toContain("Candidates:       3");
    expect(text).toContain("Dispatched:       3");
    expect(text).toContain("Duration: 12.5s");
  });

  it("lists dispatch errors when present", () => {
    const { text, html } = formatCronReport({
      ...baseReport,
      status: "degraded",
      dispatchErrors: 2,
      dispatchErrorDetail: [
        { orgSlug: "acme", error: "502 bad gateway" },
        { orgSlug: "beta", error: "timeout" },
      ],
    });
    expect(text).toContain("acme: 502 bad gateway");
    expect(text).toContain("beta: timeout");
    expect(html).toContain("<strong>acme</strong>");
    expect(html).toContain("502 bad gateway");
  });

  it("escapes HTML in error detail to prevent injection", () => {
    const { html } = formatCronReport({
      ...baseReport,
      status: "degraded",
      dispatchErrors: 1,
      dispatchErrorDetail: [{ orgSlug: "x", error: "<script>alert(1)</script>" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes detail link when adminBaseUrl is provided", () => {
    const { text, html } = formatCronReport({ ...baseReport, adminBaseUrl: "https://api.releases.sh" });
    expect(text).toContain("https://api.releases.sh/v1/admin/cron-runs/cron_run_01");
    expect(html).toContain("/v1/admin/cron-runs/cron_run_01");
  });

  it("omits detail link when adminBaseUrl is missing", () => {
    const { text } = formatCronReport(baseReport);
    expect(text).not.toContain("Detail:");
  });

  it("formats duration under 1s as milliseconds", () => {
    const { text } = formatCronReport({ ...baseReport, durationMs: 850 });
    expect(text).toContain("Duration: 850ms");
  });

  it("formats duration over 60s as minutes and seconds", () => {
    const { text } = formatCronReport({ ...baseReport, durationMs: 125000 });
    expect(text).toContain("Duration: 2m5s");
  });

  it("handles null durationMs", () => {
    const { text } = formatCronReport({ ...baseReport, durationMs: null });
    expect(text).toContain("Duration: n/a");
  });

  it("includes abort reason in status line", () => {
    const { text } = formatCronReport({ ...baseReport, status: "aborted", abortReason: "anthropic_credits" });
    expect(text).toContain("Status: aborted (anthropic_credits)");
  });

  it("lists sessions when provided", () => {
    const { text } = formatCronReport({
      ...baseReport,
      sessionsStarted: ["ma_1", "ma_2"],
    });
    expect(text).toContain("Sessions (2):");
    expect(text).toContain("- ma_1");
    expect(text).toContain("- ma_2");
  });
});
