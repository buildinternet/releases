import { describe, it, expect } from "bun:test";
import { stripAnsi } from "../../src/lib/sanitize.js";
import { formatActiveFetchBanner, formatStatusLabel } from "../../src/cli/commands/fetch-log.js";

/**
 * #1360: the fetch-log view renders an in-progress banner for a source whose
 * managed-agent fetch is still running, so an operator can tell "running" from
 * "stuck". Tested as a pure formatter — command wiring stays thin.
 */
describe("formatActiveFetchBanner (#1360)", () => {
  it("includes the session id, an in-progress marker, and a started-ago time", () => {
    const banner = stripAnsi(
      formatActiveFetchBanner({
        sessionId: "ma-1a2b3c4d",
        status: "running",
        startedAt: Date.now() - 120_000,
        lastUpdatedAt: Date.now(),
      }),
    );

    expect(banner.toLowerCase()).toContain("in progress");
    expect(banner).toContain("ma-1a2b3c4d");
    expect(banner.toLowerCase()).toContain("started");
  });

  it("falls back to 'just now' when the start time does not yield a relative string", () => {
    const banner = stripAnsi(
      formatActiveFetchBanner({
        sessionId: "ma-x",
        status: "running",
        startedAt: Date.now(),
        lastUpdatedAt: Date.now(),
      }),
    );

    // A near-now start should still produce a readable "started …" clause.
    expect(banner.toLowerCase()).toContain("started");
  });
});

describe("formatStatusLabel (#1360)", () => {
  it("labels crawl_timeout and blocked distinctly, not as 'no change'", () => {
    expect(stripAnsi(formatStatusLabel("crawl_timeout"))).toBe("crawl timeout");
    expect(stripAnsi(formatStatusLabel("blocked"))).toBe("blocked");
  });

  it("keeps the existing labels for known statuses", () => {
    expect(stripAnsi(formatStatusLabel("success"))).toBe("success");
    expect(stripAnsi(formatStatusLabel("error"))).toBe("error");
    expect(stripAnsi(formatStatusLabel("no_change"))).toBe("no change");
    expect(stripAnsi(formatStatusLabel("dry_run"))).toBe("dry run");
  });

  it("shows an unknown status verbatim instead of mislabeling it 'no change'", () => {
    expect(stripAnsi(formatStatusLabel("something_new"))).toBe("something_new");
  });
});
