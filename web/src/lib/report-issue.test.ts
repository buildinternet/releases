import { describe, expect, it } from "bun:test";
import { buildReportMessage, type ReportContext } from "./report-issue";

const release: ReportContext = {
  kind: "release",
  name: "Claude 4",
  id: "rel_abc123",
  path: "/release/rel_abc123-claude-4",
};

const org: ReportContext = {
  kind: "org",
  name: "Anthropic",
  slug: "anthropic",
  path: "/anthropic",
};

describe("buildReportMessage", () => {
  it("prefixes entity + live URL above the note", () => {
    expect(
      buildReportMessage(
        "wrong product",
        release,
        "https://releases.sh/release/rel_abc123-claude-4",
      ),
    ).toBe(
      [
        'About: release "Claude 4" (rel_abc123)',
        "Page: https://releases.sh/release/rel_abc123-claude-4",
        "",
        "wrong product",
      ].join("\n"),
    );
  });

  it("falls back to path when no live URL is available", () => {
    expect(buildReportMessage("stale overview", org, null)).toBe(
      ['About: org "Anthropic" (anthropic)', "Page: /anthropic", "", "stale overview"].join("\n"),
    );
  });
});
