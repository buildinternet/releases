import { describe, it, expect } from "bun:test";
import { parseChangelog, mapGitHubReleases } from "@buildinternet/releases-core/changelog-parse";

const keepAChangelog = [
  "# Changelog",
  "",
  "All notable changes.",
  "",
  "## [Unreleased]",
  "",
  "- work in progress",
  "",
  "## [1.4.0] - 2026-05-01",
  "",
  "### Added",
  "- new --json flag",
  "",
  "### Fixed",
  "- crash on empty input",
  "",
  "## [1.3.0] - 2026-04-01",
  "",
  "### Changed",
  "- tweaked defaults",
  "",
].join("\n");

const conventional = [
  "# Changelog",
  "",
  "## [2.0.0](https://github.com/o/r/compare/v1.9.0...v2.0.0) (2026-05-10)",
  "",
  "### Features",
  "- big thing",
  "",
  "## 1.9.0 (2026-04-20)",
  "",
  "### Bug Fixes",
  "- small thing",
  "",
].join("\n");

const plain = ["# Changelog", "", "## v1.0.0", "", "- first release", ""].join("\n");

const prerelease = ["## 2.0.0-rc.1 - 2026-05-15", "", "- candidate", ""].join("\n");

const prose = [
  "# Release notes",
  "",
  "## Welcome",
  "",
  "Thanks for using our product.",
  "",
  "## Support",
  "",
  "Email us.",
  "",
].join("\n");

describe("parseChangelog", () => {
  it("parses Keep a Changelog, skipping Unreleased", () => {
    const result = parseChangelog(keepAChangelog);
    expect(result.parsable).toBe(true);
    expect(result.format).toBe("keep-a-changelog");
    expect(result.skipped).toBe(1); // Unreleased
    expect(result.headingsScanned).toBe(3); // Unreleased + 2 versions
    expect(result.releases.map((r) => r.version)).toEqual(["1.4.0", "1.3.0"]);

    const first = result.releases[0];
    expect(first.title).toBe("1.4.0");
    expect(first.type).toBe("feature");
    expect(first.publishedAt).toBe("2026-05-01");
    expect(first.prerelease).toBe(false);
    expect(first.summary).toBeNull();
    expect(first.titleGenerated).toBeNull();
    expect(first.titleShort).toBeNull();
    expect(first.media).toEqual([]);
    expect(first.content).toContain("### Added");
    expect(first.content).toContain("crash on empty input");
    expect(first.content).not.toContain("## [1.3.0]"); // stops at next version heading
  });

  it("parses conventional-changelog with linked version headings", () => {
    const result = parseChangelog(conventional);
    expect(result.parsable).toBe(true);
    expect(result.format).toBe("conventional");
    expect(result.releases[0].version).toBe("2.0.0");
    expect(result.releases[0].url).toBe("https://github.com/o/r/compare/v1.9.0...v2.0.0");
    expect(result.releases[0].publishedAt).toBe("2026-05-10");
    expect(result.releases[1].version).toBe("1.9.0");
    expect(result.releases[1].url).toBeNull();
    expect(result.releases[1].publishedAt).toBe("2026-04-20");
  });

  it("parses plain version headings with no dates", () => {
    const result = parseChangelog(plain);
    expect(result.parsable).toBe(true);
    expect(result.format).toBe("plain");
    expect(result.releases[0].version).toBe("1.0.0"); // leading v stripped
    expect(result.releases[0].publishedAt).toBeNull();
  });

  it("flags prerelease versions", () => {
    const result = parseChangelog(prerelease);
    expect(result.releases[0].version).toBe("2.0.0-rc.1");
    expect(result.releases[0].prerelease).toBe(true);
  });

  it("returns parsable:false for a prose file with no version headings", () => {
    const result = parseChangelog(prose);
    expect(result.parsable).toBe(false);
    expect(result.format).toBe("unknown");
    expect(result.releases).toEqual([]);
    expect(result.skipped).toBe(2); // Welcome, Support
  });

  it("returns parsable:false for empty input", () => {
    const result = parseChangelog("");
    expect(result.parsable).toBe(false);
    expect(result.releases).toEqual([]);
  });
});

describe("mapGitHubReleases", () => {
  it("maps API rows straight into entries", () => {
    const entries = mapGitHubReleases([
      {
        tag_name: "v1.4.0",
        name: "Version 1.4.0",
        body: "## What's changed\n- a thing",
        html_url: "https://github.com/o/r/releases/tag/v1.4.0",
        published_at: "2026-05-01T12:00:00Z",
        prerelease: false,
      },
      {
        tag_name: "v2.0.0-beta.1",
        name: null,
        body: null,
        html_url: "https://github.com/o/r/releases/tag/v2.0.0-beta.1",
        published_at: null,
        prerelease: true,
      },
    ]);

    expect(entries).toHaveLength(2);

    expect(entries[0].version).toBe("v1.4.0");
    expect(entries[0].title).toBe("Version 1.4.0");
    expect(entries[0].content).toContain("a thing");
    expect(entries[0].url).toBe("https://github.com/o/r/releases/tag/v1.4.0");
    expect(entries[0].publishedAt).toBe("2026-05-01T12:00:00Z");
    expect(entries[0].prerelease).toBe(false);
    expect(entries[0].type).toBe("feature");
    expect(entries[0].summary).toBeNull();
    expect(entries[0].media).toEqual([]);

    // name falls back to tag_name; null body → ""
    expect(entries[1].title).toBe("v2.0.0-beta.1");
    expect(entries[1].content).toBe("");
    expect(entries[1].publishedAt).toBeNull();
    expect(entries[1].prerelease).toBe(true);
  });

  it("returns [] for no releases", () => {
    expect(mapGitHubReleases([])).toEqual([]);
  });
});
