# On-demand Changelog Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/changelog/parse` — a no-persistence endpoint that returns a GitHub repo's changelog as structured release entries (stored-release shape) resolved deterministically from GitHub Releases or a parsed `CHANGELOG.md`.

**Architecture:** Two pure, runtime-neutral producers in `@buildinternet/releases-core/changelog-parse` (`parseChangelog` for markdown, `mapGitHubReleases` for the GitHub Releases API shape) both emit `ParsedChangelogRelease[]`. A worker handler in `workers/api/src/routes/changelog.ts` (sibling to the existing `/changelog/fetch`) does the GitHub fetches, applies a prefer-one-fallback resolution order, and returns a single `source` per response.

**Tech Stack:** Bun, TypeScript (strict), Hono, `bun:test`. No DB, no AI. Reuses existing helpers: `classifyRepoStatus`, `discoverChangelogPathsViaTree`, `selectChangelogFile`, `buildGitHubHeaders`, `createListingCache`, `parseCoordinate`, `isPrereleaseVersion`.

**Spec:** `docs/superpowers/specs/2026-05-23-on-demand-changelog-parse-design.md`

---

## File Structure

- **`packages/core/src/changelog-parse.ts`** (new) — pure producers + types. The only file that knows how a changelog becomes `ParsedChangelogRelease[]`. No I/O, no worker imports. Reuses `isPrereleaseVersion` from `./prerelease`.
- **`packages/core/package.json`** (modify) — add the `./changelog-parse` export subpath.
- **`tests/unit/changelog-parse.test.ts`** (new) — unit tests for both producers, run by root `bun test`.
- **`workers/api/src/routes/changelog.ts`** (modify) — add the `/changelog/parse` route, handler, two private resolver helpers, and the local zod response schema. Sibling to the existing `/changelog/fetch` in the same file (follows the established one-file pattern).
- **`workers/api/test/changelog-parse.test.ts`** (new) — worker route tests with mocked `globalThis.fetch`, mirroring `workers/api/test/changelog-fetch.test.ts`.

`workers/api/src/route-namespaces.ts` already lists `"changelog"` in `publicReadRoutes`, so the write-gate (Bearer on non-SAFE methods) is already in place — **no change needed** (verified in spec prep).

---

## Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies in this worktree**

This worktree has no `node_modules`. Without this, `@buildinternet/releases-core/changelog-parse` resolves to the main checkout and tests read stale/undefined exports.

Run: `bun install`
Expected: completes; `node_modules/@buildinternet/releases-core` symlink now exists.

- [ ] **Step 2: Confirm the baseline is green**

Run: `bun test tests/unit/changelog-slice.test.ts`
Expected: PASS (sanity check that the workspace resolves).

---

## Task 1: Core — `parseChangelog` (the `changelog_file` source)

**Files:**
- Create: `packages/core/src/changelog-parse.ts`
- Modify: `packages/core/package.json` (exports map)
- Test: `tests/unit/changelog-parse.test.ts`

- [ ] **Step 1: Add the export subpath**

In `packages/core/package.json`, find the `"exports"` block containing `"./changelog-slice": "./src/changelog-slice.ts"` and add a sibling line immediately after it:

```jsonc
    "./changelog-slice": "./src/changelog-slice.ts",
    "./changelog-parse": "./src/changelog-parse.ts",
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/changelog-parse.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseChangelog } from "@buildinternet/releases-core/changelog-parse";

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/unit/changelog-parse.test.ts`
Expected: FAIL — `Cannot find module '@buildinternet/releases-core/changelog-parse'`.

- [ ] **Step 4: Implement `parseChangelog`**

Create `packages/core/src/changelog-parse.ts`:

```ts
/**
 * Deterministic changelog → structured releases, in the stored-release shape.
 * Two producers, both pure and runtime-neutral: `parseChangelog` for markdown
 * files and `mapGitHubReleases` for the GitHub Releases API. Used by the
 * experimental `POST /v1/changelog/parse` endpoint (no persistence) and any
 * client (CLI) that wants the same shape without a server round-trip.
 */

import { isPrereleaseVersion } from "./prerelease";

/**
 * A single release entry. Mirrors the parse-relevant subset of the stored
 * release shape (`ReleaseDetailResponseSchema`). AI-only fields are always
 * null and `media` is always empty — deterministic parsing can't produce them.
 */
export interface ParsedChangelogRelease {
  version: string | null;
  /** Deterministic default; the "rollup" type is AI-classified and never emitted here. */
  type: "feature";
  title: string;
  content: string;
  url: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  summary: null;
  titleGenerated: null;
  titleShort: null;
  media: [];
}

export type ChangelogFormat = "keep-a-changelog" | "conventional" | "plain" | "unknown";

export interface ParseChangelogResult {
  /** True when ≥1 version-shaped `##` heading was found. */
  parsable: boolean;
  format: ChangelogFormat;
  releases: ParsedChangelogRelease[];
  /** Total level-2 headings seen (parsed + skipped). */
  headingsScanned: number;
  /** Version-less headings (e.g. `## [Unreleased]`, prose section titles). */
  skipped: number;
}

/** Matches a level-2 heading (`##`, not `###`), capturing the heading text. */
const LEVEL2_HEADING = /^##(?!#)\s+(.+?)\s*$/;

type HeadingStyle = "link" | "bracket" | "plain";

interface ParsedHeading {
  version: string;
  url: string | null;
  publishedAt: string | null;
  style: HeadingStyle;
}

/** Strip a leading `v`, then accept only version-ish tokens (must contain a digit). */
function normalizeVersion(token: string): string | null {
  const v = token.trim().replace(/^v/i, "");
  if (!/\d/.test(v)) return null;
  if (!/^\d[\w.\-+]*$/.test(v)) return null;
  return v;
}

/**
 * Pull a version (+ optional date and link href) out of a `##` heading.
 * Handles `[1.4.0](href) (date)`, `[1.4.0] - date`, `1.4.0 (date)`, `v1.4.0`.
 * Returns null for version-less headings (e.g. `[Unreleased]`).
 */
function parseHeading(headingText: string): ParsedHeading | null {
  let text = headingText.trim();
  let url: string | null = null;
  let style: HeadingStyle = "plain";

  const link = text.match(/^\[([^\]]+)\]\(([^)]+)\)/);
  if (link) {
    style = "link";
    url = link[2];
    text = (link[1].trim() + text.slice(link[0].length)).trim();
  } else {
    const bracket = text.match(/^\[([^\]]+)\]/);
    if (bracket) {
      style = "bracket";
      text = (bracket[1].trim() + text.slice(bracket[0].length)).trim();
    }
  }

  const date = text.match(/(\d{4}-\d{2}-\d{2})/);
  const publishedAt = date ? date[1] : null;

  const firstToken = text.split(/[\s,(]+/)[0] ?? "";
  const version = normalizeVersion(firstToken);
  if (!version) return null;

  return { version, url, publishedAt, style };
}

export function parseChangelog(markdown: string): ParseChangelogResult {
  const lines = markdown.split("\n");

  const headings: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LEVEL2_HEADING);
    if (m) headings.push({ line: i, text: m[1] });
  }

  const releases: ParsedChangelogRelease[] = [];
  let skipped = 0;
  let sawLink = false;
  let sawBracket = false;

  for (let h = 0; h < headings.length; h++) {
    const parsed = parseHeading(headings[h].text);
    if (!parsed) {
      skipped++;
      continue;
    }
    if (parsed.style === "link") sawLink = true;
    else if (parsed.style === "bracket") sawBracket = true;

    const start = headings[h].line + 1;
    const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const content = lines.slice(start, end).join("\n").trim();

    releases.push({
      version: parsed.version,
      type: "feature",
      title: parsed.version,
      content,
      url: parsed.url,
      publishedAt: parsed.publishedAt,
      prerelease: isPrereleaseVersion(parsed.version),
      summary: null,
      titleGenerated: null,
      titleShort: null,
      media: [],
    });
  }

  // conventional (linked headings) > keep-a-changelog (bracketed) > plain.
  const format: ChangelogFormat =
    releases.length === 0
      ? "unknown"
      : sawLink
        ? "conventional"
        : sawBracket
          ? "keep-a-changelog"
          : "plain";

  return {
    parsable: releases.length > 0,
    format,
    releases,
    headingsScanned: headings.length,
    skipped,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/changelog-parse.test.ts`
Expected: PASS (all `parseChangelog` cases green; `mapGitHubReleases` is added in Task 2).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/changelog-parse.ts packages/core/package.json tests/unit/changelog-parse.test.ts
git commit -m "feat(core): deterministic parseChangelog (file source for /changelog/parse)"
```

---

## Task 2: Core — `mapGitHubReleases` (the `github_releases` source)

**Files:**
- Modify: `packages/core/src/changelog-parse.ts`
- Test: `tests/unit/changelog-parse.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/changelog-parse.test.ts` (add the import name and a new `describe`):

```ts
import { parseChangelog, mapGitHubReleases } from "@buildinternet/releases-core/changelog-parse";
```

(replace the existing single-name import line with the line above, then add:)

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/changelog-parse.test.ts`
Expected: FAIL — `mapGitHubReleases is not a function` / not exported.

- [ ] **Step 3: Implement `mapGitHubReleases`**

Append to `packages/core/src/changelog-parse.ts`:

```ts
/**
 * Minimal structural shape of a GitHub Releases API row. Declared here (rather
 * than importing the adapter's `GitHubRelease`) to keep core free of an
 * adapters dependency. Mirrors `packages/adapters/src/github.ts`'s shape.
 */
export interface GitHubReleaseLike {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
}

/**
 * Map GitHub Releases API rows into entries. The API is already structured, so
 * there's no parsing: `published_at` and `prerelease` are authoritative.
 */
export function mapGitHubReleases(releases: GitHubReleaseLike[]): ParsedChangelogRelease[] {
  return releases.map((r) => ({
    version: r.tag_name,
    type: "feature" as const,
    title: r.name || r.tag_name,
    content: (r.body ?? "").trim(),
    url: r.html_url,
    publishedAt: r.published_at,
    prerelease: r.prerelease === true,
    summary: null,
    titleGenerated: null,
    titleShort: null,
    media: [],
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/changelog-parse.test.ts`
Expected: PASS (all `parseChangelog` + `mapGitHubReleases` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/changelog-parse.ts tests/unit/changelog-parse.test.ts
git commit -m "feat(core): mapGitHubReleases (GitHub Releases source for /changelog/parse)"
```

---

## Task 3: Worker — `POST /v1/changelog/parse` route + handler

**Files:**
- Modify: `workers/api/src/routes/changelog.ts`
- Test: `workers/api/test/changelog-parse.test.ts`

- [ ] **Step 1: Write the failing worker test**

Create `workers/api/test/changelog-parse.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { changelogRoutes } from "../src/routes/changelog.js";
import type { Env } from "../src/index.js";

const TEST_ENV = {} as Env["Bindings"];

type FetchHandler = (url: string) => Response | Promise<Response>;
let originalFetch: typeof fetch;

function installFetch(handler: FetchHandler) {
  originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url);
  }) as typeof fetch;
}

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function call(body: Record<string, unknown>) {
  return changelogRoutes.request(
    "/changelog/parse",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    TEST_ENV,
  );
}

const RELEASES_URL = "https://api.github.com/repos/owner/repo/releases?per_page=100";
const TREE_URL = "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1";
const ROOT_CHANGELOG = "https://raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md";

type ParseBody = {
  repo: string;
  source: "github_releases" | "changelog_file" | null;
  parsable: boolean;
  format: string | null;
  file: { path: string; truncated: boolean } | null;
  releases: { version: string | null; title: string; publishedAt: string | null }[];
  stats: { releasesParsed: number; githubRequests: number };
};

describe("POST /changelog/parse", () => {
  it("auto: prefers GitHub Releases when they have bodies", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) {
        return json([
          {
            tag_name: "v2.0.0",
            name: "2.0.0",
            body: "- big change",
            html_url: "https://github.com/owner/repo/releases/tag/v2.0.0",
            published_at: "2026-05-01T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("github_releases");
    expect(body.parsable).toBe(true);
    expect(body.format).toBeNull();
    expect(body.file).toBeNull();
    expect(body.releases[0].version).toBe("v2.0.0");
    expect(body.stats.releasesParsed).toBe(1);
    // 1 precheck + 1 releases call
    expect(body.stats.githubRequests).toBe(2);
  });

  it("auto: falls back to CHANGELOG.md when there are no releases", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) return json([]); // no releases
      if (url === TREE_URL) {
        return json({
          truncated: false,
          tree: [{ path: "CHANGELOG.md", type: "blob", size: 60 }],
        });
      }
      if (url === ROOT_CHANGELOG) return text("# Changelog\n\n## [1.0.0] - 2026-01-01\n- first");
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("changelog_file");
    expect(body.parsable).toBe(true);
    expect(body.format).toBe("keep-a-changelog");
    expect(body.file?.path).toBe("CHANGELOG.md");
    expect(body.releases[0].version).toBe("1.0.0");
    expect(body.releases[0].publishedAt).toBe("2026-01-01");
  });

  it("auto: returns parsable:false when neither source exists", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) return json([]);
      if (url === TREE_URL) return json({ truncated: false, tree: [] });
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.parsable).toBe(false);
    expect(body.source).toBeNull();
    expect(body.releases).toEqual([]);
  });

  it("source=changelog_file forces the file even when releases exist", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) {
        // releases exist, but we forced the file source — must not be consulted
        return json([{ tag_name: "v9", name: null, body: "x", html_url: "h", published_at: null, prerelease: false }]);
      }
      if (url === TREE_URL) {
        return json({ truncated: false, tree: [{ path: "CHANGELOG.md", type: "blob", size: 30 }] });
      }
      if (url === ROOT_CHANGELOG) return text("## v1.0.0\n- first");
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo", source: "changelog_file" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("changelog_file");
    expect(body.releases[0].version).toBe("1.0.0");
  });

  it("explicit path targets a workspace changelog", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === TREE_URL) {
        return json({
          truncated: false,
          tree: [
            { path: "CHANGELOG.md", type: "blob", size: 10 },
            { path: "packages/core/CHANGELOG.md", type: "blob", size: 20 },
          ],
        });
      }
      if (url === "https://raw.githubusercontent.com/owner/repo/HEAD/packages/core/CHANGELOG.md") {
        return text("## v0.1.0\n- core first");
      }
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo", path: "packages/core/CHANGELOG.md" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("changelog_file");
    expect(body.file?.path).toBe("packages/core/CHANGELOG.md");
    expect(body.releases[0].version).toBe("0.1.0");
  });

  it("explicit path that does not exist → 404", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === TREE_URL) {
        return json({ truncated: false, tree: [{ path: "CHANGELOG.md", type: "blob", size: 10 }] });
      }
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo", path: "does/not/exist.md" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("returns 400 when repo is missing", async () => {
    installFetch(() => json({}));
    const res = await call({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("returns 400 for an invalid source value", async () => {
    installFetch(() => json({}));
    const res = await call({ repo: "owner/repo", source: "bogus" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("maps a missing repo to 404 via the precheck", async () => {
    installFetch((url) =>
      url === "https://api.github.com/repos/ghost/repo"
        ? new Response("nope", { status: 404 })
        : json({}),
    );
    const res = await call({ repo: "ghost/repo" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("repo_not_found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/api && bun test test/changelog-parse.test.ts; cd ../..`
Expected: FAIL — the route returns 404 for `/changelog/parse` (not registered yet), so assertions fail.

- [ ] **Step 3: Add imports to the route file**

In `workers/api/src/routes/changelog.ts`, the `discoverChangelogPathsViaTree`, `buildGitHubHeaders`, `createListingCache` import from `@releases/adapters/github-discovery` already exists. Extend it and add the core import. Find:

```ts
import {
  discoverChangelogPathsViaTree,
  buildGitHubHeaders,
  createListingCache,
} from "@releases/adapters/github-discovery";
```

Leave that as-is, and add these imports after the existing `parseCoordinate` import line:

```ts
import { selectChangelogFile } from "@buildinternet/releases-core/changelog-slice";
import {
  parseChangelog,
  mapGitHubReleases,
  type ParsedChangelogRelease,
  type GitHubReleaseLike,
} from "@buildinternet/releases-core/changelog-parse";
```

- [ ] **Step 4: Add the response schema + handler + route**

In `workers/api/src/routes/changelog.ts`, just above the final `export const changelogRoutes = new Hono<Env>();` line, add the schema, handler, and helpers. Then register the route.

Add the schemas and route description:

```ts
const PARSE_SOURCES = ["auto", "github_releases", "changelog_file"] as const;

const ParsedReleaseSchema = z.object({
  version: z.string().nullable(),
  type: z.literal("feature"),
  title: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  summary: z.null(),
  titleGenerated: z.null(),
  titleShort: z.null(),
  // always empty at runtime; z.unknown() keeps OpenAPI spec generation safe.
  media: z.array(z.unknown()),
});

const ChangelogParseFileSchema = z.object({
  path: z.string(),
  url: z.string(),
  rawUrl: z.string(),
  size: z.number().nullable(),
  truncated: z.boolean(),
});

const ChangelogParseResponseSchema = z.object({
  repo: z.string(),
  source: z.enum(["github_releases", "changelog_file"]).nullable(),
  parsable: z.boolean(),
  format: z
    .enum(["keep-a-changelog", "conventional", "plain", "unknown"])
    .nullable(),
  file: ChangelogParseFileSchema.nullable(),
  releases: z.array(ParsedReleaseSchema),
  stats: z.object({
    releasesParsed: z.number(),
    headingsScanned: z.number(),
    skipped: z.number(),
    githubRequests: z.number(),
    bytes: z.number(),
    elapsedMs: z.number(),
  }),
});

const parseChangelogRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Changelog"],
  summary: "Parse a GitHub repo's changelog into structured releases (experimental, no persistence)",
  description:
    'Experimental. Given a `{ repo: "owner/repo", path?, source? }` coordinate, resolves the repo\'s changelog deterministically from the best available source — GitHub Releases (already structured) or a parsed root `CHANGELOG.md` — and returns release entries in the stored-release shape. `source` is `"auto"` (default), `"github_releases"`, or `"changelog_file"`; `path` forces the file source at that path. Nothing is written. Auth: Bearer (write). Hidden from the production OpenAPI spec.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Structured releases plus the resolved source and stats",
      content: { "application/json": { schema: resolver(ChangelogParseResponseSchema) } },
    },
    400: {
      description: "Missing/invalid `repo`, unparseable coordinate, or invalid `source`",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Repo not found, or an explicit `path` that does not exist",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    502: { description: "GitHub auth error or upstream 5xx", content: { "application/json": { schema: resolver(ErrorResponseSchema) } } },
    503: { description: "GitHub rate limit exceeded", content: { "application/json": { schema: resolver(ErrorResponseSchema) } } },
  },
});
```

Add the resolver helpers and handler:

```ts
type ChangelogParseSource = (typeof PARSE_SOURCES)[number];

/** Fetch + map a repo's GitHub Releases (one page). Returns [] on any non-ok. */
async function fetchGitHubReleases(
  owner: string,
  repo: string,
  apiHeaders: Record<string, string>,
): Promise<ParsedChangelogRelease[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
    { headers: apiHeaders },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as GitHubReleaseLike[] | null;
  if (!Array.isArray(data)) return [];
  return mapGitHubReleases(data);
}

interface ResolvedFile {
  file: z.infer<typeof ChangelogParseFileSchema>;
  result: ReturnType<typeof parseChangelog>;
}

/**
 * Discover + select one CHANGELOG file (root by default, or `path`), fetch its
 * full body (≤ MAX_BYTES), and parse it. Returns null when no file is found.
 */
async function resolveChangelogFile(
  owner: string,
  repo: string,
  headers: ReturnType<typeof buildGitHubHeaders>,
  cache: ReturnType<typeof createListingCache>,
  path: string | null,
): Promise<ResolvedFile | null> {
  const syntheticSource = {
    url: `https://github.com/${owner}/${repo}`,
    metadata: null,
  } as unknown as Source;

  const discovered = (
    (await discoverChangelogPathsViaTree(syntheticSource, headers, cache)) ?? []
  ).filter((p) => p.exists);
  const selected = selectChangelogFile(discovered, path);
  if (!selected) return null;

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${selected.path}`;
  let body = "";
  let truncated = false;
  try {
    const res = await fetch(rawUrl, { headers: headers.rawHeaders });
    if (res.ok) {
      body = await res.text();
      truncated = encoder.encode(body).length > MAX_BYTES;
    }
  } catch {
    // leave body empty on fetch failure
  }

  return {
    file: {
      path: selected.path,
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${selected.path}`,
      rawUrl,
      size: selected.size,
      truncated,
    },
    result: parseChangelog(body),
  };
}

const parseChangelogHandler = async (c: import("hono").Context<Env>) => {
  const startedAt = Date.now();

  const body = (await c.req.json().catch(() => null)) as
    | { repo?: unknown; path?: unknown; source?: unknown }
    | null;

  const repoInput = typeof body?.repo === "string" ? body.repo.trim() : "";
  if (!repoInput) {
    return c.json(
      { error: "bad_request", message: 'Body must include a "repo" string, e.g. { "repo": "owner/repo" }' },
      400,
    );
  }

  const coord = parseCoordinate(repoInput);
  if (!coord) {
    return c.json(
      { error: "bad_request", message: `Cannot parse "${repoInput}" as a github owner/repo coordinate` },
      400,
    );
  }

  const pathInput = typeof body?.path === "string" && body.path.trim() ? body.path.trim() : null;

  const sourceRaw = typeof body?.source === "string" ? body.source.trim() : "auto";
  if (!(PARSE_SOURCES as readonly string[]).includes(sourceRaw)) {
    return c.json(
      { error: "bad_request", message: `Invalid "source": ${sourceRaw}. Use one of: ${PARSE_SOURCES.join(", ")}` },
      400,
    );
  }
  // A path names a file, so it forces the changelog_file source.
  const source: ChangelogParseSource = pathInput ? "changelog_file" : (sourceRaw as ChangelogParseSource);

  const { org: owner, repo } = coord;
  const token = (await getSecret(c.env.GITHUB_TOKEN)) ?? undefined;
  const headers = buildGitHubHeaders(token, RELEASES_BOT_UA);

  const repoStatus = await classifyRepoStatus({ owner, repo }, headers.apiHeaders);
  if (repoStatus.kind !== "ok") {
    return c.json(repoStatus.body, repoStatus.status);
  }

  const cache = createListingCache();
  let githubRequests = 1; // precheck

  let resolvedSource: "github_releases" | "changelog_file" | null = null;
  let releases: ParsedChangelogRelease[] = [];
  let file: z.infer<typeof ChangelogParseFileSchema> | null = null;
  let format: z.infer<typeof ChangelogParseResponseSchema>["format"] = null;
  let headingsScanned = 0;
  let skipped = 0;

  const runReleases = async () => {
    githubRequests++;
    return fetchGitHubReleases(owner, repo, headers.apiHeaders);
  };

  const runFile = async () => {
    const before = cache.requests;
    const resolved = await resolveChangelogFile(owner, repo, headers, cache, pathInput);
    // discovery listing/tree calls + the single raw body fetch (when a file matched)
    githubRequests += cache.requests - before + (resolved ? 1 : 0);
    return resolved;
  };

  if (source === "changelog_file") {
    const resolved = await runFile();
    if (!resolved) {
      // An explicit path the caller asserted must exist is a 404; an absent
      // root changelog is just "nothing to show".
      if (pathInput) {
        return c.json({ error: "not_found", message: `No changelog file at "${pathInput}" in ${owner}/${repo}` }, 404);
      }
    } else {
      file = resolved.file;
      format = resolved.result.format;
      headingsScanned = resolved.result.headingsScanned;
      skipped = resolved.result.skipped;
      if (resolved.result.parsable) {
        resolvedSource = "changelog_file";
        releases = resolved.result.releases;
      }
    }
  } else if (source === "github_releases") {
    const rel = await runReleases();
    if (rel.length > 0) {
      resolvedSource = "github_releases";
      releases = rel;
    }
  } else {
    // auto: prefer GitHub Releases with non-trivial bodies, else CHANGELOG.md,
    // else any releases that exist (thin), else nothing.
    const rel = await runReleases();
    const hasBody = rel.some((r) => r.content.trim().length > 0);
    if (rel.length > 0 && hasBody) {
      resolvedSource = "github_releases";
      releases = rel;
    } else {
      const resolved = await runFile();
      if (resolved) {
        file = resolved.file;
        format = resolved.result.format;
        headingsScanned = resolved.result.headingsScanned;
        skipped = resolved.result.skipped;
      }
      if (resolved?.result.parsable) {
        resolvedSource = "changelog_file";
        releases = resolved.result.releases;
      } else if (rel.length > 0) {
        // Releases exist but are body-less; better than nothing.
        resolvedSource = "github_releases";
        releases = rel;
        file = null;
        format = null;
      }
    }
  }

  const stats = {
    releasesParsed: releases.length,
    headingsScanned,
    skipped,
    githubRequests,
    bytes: file && resolvedSource === "changelog_file" ? (file.size ?? 0) : 0,
    elapsedMs: Date.now() - startedAt,
  };

  logEvent("info", {
    component: "changelog-parse-experiment",
    event: "parsed",
    repo: `${owner}/${repo}`,
    source: resolvedSource,
    ...stats,
  });

  return c.json({
    repo: `${owner}/${repo}`,
    source: resolvedSource,
    parsable: releases.length > 0,
    format: resolvedSource === "changelog_file" ? format : null,
    file: resolvedSource === "changelog_file" ? file : null,
    releases,
    stats,
  });
};
```

Finally, register the route alongside the existing `/changelog/fetch` registration at the bottom of the file:

```ts
export const changelogRoutes = new Hono<Env>();
changelogRoutes.post("/changelog/fetch", fetchChangelogsRoute, fetchChangelogsHandler);
changelogRoutes.post("/changelog/parse", parseChangelogRoute, parseChangelogHandler);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd workers/api && bun test test/changelog-parse.test.ts; cd ../..`
Expected: PASS (all 9 cases).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/changelog.ts workers/api/test/changelog-parse.test.ts
git commit -m "feat(api): POST /v1/changelog/parse — structured releases from GitHub Releases or CHANGELOG.md"
```

---

## Task 4: Verification

**Files:** none (checks only)

- [ ] **Step 1: Type-check the root (core changes)**

Run: `npx tsc --noEmit`
Expected: no errors. (Root tsc covers `packages/` + `src/`; `tests/` is not gate-checked, so also rely on the test runs above.)

- [ ] **Step 2: Type-check the API worker**

Run: `cd workers/api && npx tsc --noEmit; cd ../..`
Expected: no errors.

- [ ] **Step 3: Run the full unit + worker test suites for the touched areas**

Run: `bun test tests/unit/changelog-parse.test.ts && cd workers/api && bun test test/changelog-parse.test.ts test/changelog-fetch.test.ts; cd ../..`
Expected: all PASS — including the existing `/changelog/fetch` tests (regression check that the shared route file still works).

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. If `format:check` flags the new files, run `bun run format` and re-commit.

- [ ] **Step 5: Final commit (if lint/format produced changes)**

```bash
git add -A
git commit -m "chore: lint/format for changelog-parse" || echo "nothing to commit"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 → `parseChangelog` (file source) + format detection + skip rules. Task 2 → `mapGitHubReleases` (GitHub Releases source). Task 3 → endpoint, inputs (`repo`/`path`/`source`), prefer-one-fallback resolution order (decision #3), error table (400/404/200-parsable:false), `source`-per-response, auth/OpenAPI via the existing namespace registration. Task 4 → verification. Success-metric sweep is out of code scope (offline, post-merge) and intentionally not a task.
- **Type consistency:** `ParsedChangelogRelease`, `GitHubReleaseLike`, `ParseChangelogResult` are defined in Task 1/2 and imported (not redefined) in Task 3. The route's `ParsedReleaseSchema` mirrors `ParsedChangelogRelease` (docs-only; the handler returns a plain object via `c.json`, not runtime-validated); `media` is `z.array(z.unknown())` for the always-`[]` field.
- **Not changed:** `workers/api/src/route-namespaces.ts` (`"changelog"` already in `publicReadRoutes`); `scripts/check-openapi-coverage.ts` (route is `hideInProduction`, like `/fetch`, so it's outside the gate).
