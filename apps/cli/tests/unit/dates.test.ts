import { describe, it, expect } from "bun:test";
import { daysAgoIso, timeAgo } from "@buildinternet/releases-core/dates";

describe("daysAgoIso", () => {
  it("returns an ISO string", () => {
    const result = daysAgoIso(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns a date approximately N days ago", () => {
    const result = new Date(daysAgoIso(1));
    const now = Date.now();
    const diff = now - result.getTime();
    // Should be within ~1 second of exactly 1 day
    expect(Math.abs(diff - 86_400_000)).toBeLessThan(1_000);
  });

  it("returns roughly now for 0 days", () => {
    const result = new Date(daysAgoIso(0));
    expect(Date.now() - result.getTime()).toBeLessThan(1_000);
  });
});

describe("timeAgo", () => {
  it("returns null for null input", () => {
    expect(timeAgo(null)).toBeNull();
  });

  it("returns 'just now' for recent timestamps", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
  });

  it("returns minutes for < 1 hour", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(timeAgo(thirtyMinAgo)).toBe("30m ago");
  });

  it("returns hours for < 24 hours", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
    expect(timeAgo(fiveHoursAgo)).toBe("5h ago");
  });

  it("returns days for < 30 days", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(timeAgo(tenDaysAgo)).toBe("10d ago");
  });

  it("returns months for >= 30 days", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(timeAgo(ninetyDaysAgo)).toBe("3mo ago");
  });
});
