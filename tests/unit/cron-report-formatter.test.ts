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
    const { subject } = formatCronReport({
      ...baseReport,
      status: "dispatch_failed",
      dispatched: 0,
      dispatchErrors: 3,
    });
    expect(subject.startsWith("[failed] ")).toBe(true);
  });

  it("prefixes subject with [degraded] when degraded", () => {
    const { subject } = formatCronReport({
      ...baseReport,
      status: "degraded",
      dispatched: 2,
      dispatchErrors: 1,
    });
    expect(subject.startsWith("[degraded] ")).toBe(true);
  });

  it("prefixes subject with [aborted] when aborted", () => {
    const { subject } = formatCronReport({
      ...baseReport,
      status: "aborted",
      abortReason: "anthropic_credits",
    });
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
    const { text, html } = formatCronReport({
      ...baseReport,
      adminBaseUrl: "https://api.releases.sh",
    });
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
    const { text } = formatCronReport({
      ...baseReport,
      status: "aborted",
      abortReason: "anthropic_credits",
    });
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

  it("subject includes inserted count when results are attached", () => {
    const { subject } = formatCronReport({
      ...baseReport,
      results: {
        sessionsWithNoActivity: 0,
        perOrg: [
          {
            orgSlug: "x",
            orgName: "X",
            sourcesFetched: 5,
            releasesFound: 12,
            releasesInserted: 8,
            errors: 0,
          },
        ],
        settleWindowMinutes: 30,
      },
    });
    expect(subject).toBe("scrape-agent-sweep: done — 3/3 dispatched → 8 inserted");
  });

  it("subject omits inserted segment when results are absent", () => {
    const { subject } = formatCronReport(baseReport);
    expect(subject).toBe("scrape-agent-sweep: done — 3/3 dispatched");
  });

  it("text body includes per-org breakdown sorted by inserted desc", () => {
    const { text } = formatCronReport({
      ...baseReport,
      results: {
        sessionsWithNoActivity: 1,
        perOrg: [
          {
            orgSlug: "acme",
            orgName: "Acme",
            sourcesFetched: 3,
            releasesFound: 12,
            releasesInserted: 8,
            errors: 0,
          },
          {
            orgSlug: "beta",
            orgName: "Beta",
            sourcesFetched: 1,
            releasesFound: 3,
            releasesInserted: 2,
            errors: 1,
          },
        ],
        settleWindowMinutes: 30,
      },
    });
    expect(text).toContain("Results (after 30min settle):");
    expect(text).toContain("Releases inserted:  10");
    expect(text).toContain("Still running:      1 session");
    // Org name leads, slug in parens (the name is what the operator recognizes).
    expect(text).toContain("- Acme (acme): fetched=3 found=12 inserted=8");
    expect(text).toContain("- Beta (beta): fetched=1 found=3 inserted=2 errors=1");
    // Acme listed before Beta (sorted by inserted desc)
    expect(text.indexOf("- Acme")).toBeLessThan(text.indexOf("- Beta"));
  });

  it("html body renders results table and escapes org slugs", () => {
    const { html } = formatCronReport({
      ...baseReport,
      results: {
        sessionsWithNoActivity: 0,
        perOrg: [
          {
            orgSlug: "<evil>",
            orgName: "Bad",
            sourcesFetched: 1,
            releasesFound: 3,
            releasesInserted: 2,
            errors: 0,
          },
        ],
        settleWindowMinutes: 30,
      },
    });
    expect(html).toContain("Results");
    expect(html).toContain("(after 30min settle)");
    expect(html).not.toContain("<evil>");
    expect(html).toContain("&lt;evil&gt;");
  });

  it("text body omits 'Still running' when all sessions reported activity", () => {
    const { text } = formatCronReport({
      ...baseReport,
      results: {
        sessionsWithNoActivity: 0,
        perOrg: [
          {
            orgSlug: "x",
            orgName: "X",
            sourcesFetched: 1,
            releasesFound: 1,
            releasesInserted: 1,
            errors: 0,
          },
        ],
        settleWindowMinutes: 30,
      },
    });
    expect(text).not.toContain("Still running");
  });

  it("text body uses singular 'session' for one inactive session", () => {
    const { text } = formatCronReport({
      ...baseReport,
      results: {
        sessionsWithNoActivity: 1,
        perOrg: [],
        settleWindowMinutes: 30,
      },
    });
    expect(text).toContain("Still running:      1 session");
    expect(text).not.toContain("1 sessions");
  });

  // Top-searches section
  it("text body omits top-searches section when topSearches is absent", () => {
    const { text } = formatCronReport(baseReport);
    expect(text).not.toContain("Top searches");
  });

  it("text body renders 'no traffic' line when topSearches is empty", () => {
    const { text } = formatCronReport({ ...baseReport, topSearches: [] });
    expect(text).toContain("Top searches (last 24h):");
    expect(text).toContain("(no search traffic)");
  });

  it("text body lists query, count, and timestamp for each top search", () => {
    const lastSeen = new Date("2026-04-28T01:00:00.000Z").getTime();
    const { text } = formatCronReport({
      ...baseReport,
      topSearches: [
        { query: "next.js", count: 5, lastSeen },
        { query: "kubernetes", count: 2, lastSeen },
      ],
    });
    expect(text).toContain("Top searches (last 24h):");
    expect(text).toContain("- next.js (5x, last seen 2026-04-28T01:00:00.000Z)");
    expect(text).toContain("- kubernetes (2x, last seen 2026-04-28T01:00:00.000Z)");
  });

  it("html body omits top-searches section when topSearches is absent", () => {
    const { html } = formatCronReport(baseReport);
    expect(html).not.toContain("Top searches");
  });

  it("html body renders 'No search traffic' when topSearches is empty", () => {
    const { html } = formatCronReport({ ...baseReport, topSearches: [] });
    expect(html).toContain("Top searches");
    expect(html).toContain("No search traffic");
  });

  it("html body renders search rows and escapes query text", () => {
    const lastSeen = new Date("2026-04-28T01:00:00.000Z").getTime();
    const { html } = formatCronReport({
      ...baseReport,
      topSearches: [{ query: "<script>xss</script>", count: 3, lastSeen }],
    });
    expect(html).toContain("Top searches");
    expect(html).not.toContain("<script>xss</script>");
    expect(html).toContain("&lt;script&gt;xss&lt;/script&gt;");
    expect(html).toContain("3x");
  });
});
