import { describe, expect, it } from "bun:test";
import { shouldShowSummaryLede } from "./summary-lede";

describe("shouldShowSummaryLede", () => {
  it("shows the lede when the body is comfortably longer than the summary", () => {
    const summary = "This release adds dark mode support and fixes a login bug.";
    const body =
      "## Dark mode\n\nWe shipped a full dark mode implementation across every screen, " +
      "including settings, the dashboard, and modals. It respects the OS preference by default.\n\n" +
      "## Bug fixes\n\nFixed an issue where some users could not log in after a password reset.";
    expect(shouldShowSummaryLede(summary, body)).toBe(true);
  });

  it("hides the lede when the body is roughly the same length as the summary", () => {
    const summary = "This release adds dark mode support and fixes a login bug.";
    const body = "Added dark mode support and fixed a login bug.";
    expect(shouldShowSummaryLede(summary, body)).toBe(false);
  });

  it("hides the lede when the body is shorter than the summary", () => {
    const summary =
      "This release introduces a comprehensive dark mode across the entire application, " +
      "fixes several login bugs, and improves overall performance for large workspaces.";
    const body = "Dark mode + fixes.";
    expect(shouldShowSummaryLede(summary, body)).toBe(false);
  });

  it("returns false when there is no summary", () => {
    expect(shouldShowSummaryLede(null, "Some body content here that is long enough.")).toBe(false);
    expect(shouldShowSummaryLede("", "Some body content here that is long enough.")).toBe(false);
  });

  it("returns false when there is no body", () => {
    expect(shouldShowSummaryLede("A summary.", null)).toBe(false);
    expect(shouldShowSummaryLede("A summary.", "")).toBe(false);
  });

  it("ignores markdown formatting characters when comparing lengths", () => {
    const summary = "Adds a new `search` API endpoint with pagination support.";
    const body =
      "# Search API\n\nWe added a new [`search`](https://example.com) endpoint that " +
      "supports **pagination**, filtering by `category`, and sorting by relevance or date.";
    expect(shouldShowSummaryLede(summary, body)).toBe(true);
  });
});
