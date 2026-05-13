import { describe, it, expect, afterEach } from "bun:test";
import {
  fetchChangelogFiles,
  discoverChangelogPaths,
  parseWorkspaces,
  parsePnpmWorkspaces,
  pickChangelogInDir,
  truncateToByteCap,
  evaluateTagFilter,
  CHANGELOG_MAX_BYTES,
} from "@releases/adapters/github";
import { github } from "@releases/adapters/github";
import type { Source } from "@buildinternet/releases-core/schema";

// Build a minimal Source that the adapter will accept.
function mkSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_test",
    slug: "owner-repo",
    name: "Owner Repo",
    type: "github",
    url: "https://github.com/owner/repo",
    orgId: null,
    productId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    lastFetchedAt: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    fetchPriority: "normal",
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    etag: null,
    isHidden: 0,
    isPrimary: 0,
    ...overrides,
  } as unknown as Source;
}

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

function restoreFetch() {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("parseWorkspaces", () => {
  it("returns [] for missing field", () => {
    expect(parseWorkspaces("{}")).toEqual([]);
  });

  it("parses array form", () => {
    expect(parseWorkspaces(JSON.stringify({ workspaces: ["packages/*", "apps/web"] }))).toEqual([
      "packages/*",
      "apps/web",
    ]);
  });

  it("parses { packages: [] } form", () => {
    expect(parseWorkspaces(JSON.stringify({ workspaces: { packages: ["libs/*"] } }))).toEqual([
      "libs/*",
    ]);
  });

  it("returns [] on malformed json", () => {
    expect(parseWorkspaces("not json")).toEqual([]);
  });
});

describe("pickChangelogInDir", () => {
  it("picks CHANGELOG.md first", () => {
    expect(
      pickChangelogInDir([
        { name: "package.json", type: "file" },
        { name: "CHANGELOG.md", type: "file" },
        { name: "src", type: "dir" },
      ]),
    ).toBe("CHANGELOG.md");
  });

  it("falls through to HISTORY.md when CHANGELOG.md missing", () => {
    expect(
      pickChangelogInDir([
        { name: "HISTORY.md", type: "file" },
        { name: "README.md", type: "file" },
      ]),
    ).toBe("HISTORY.md");
  });

  it("returns null when no match", () => {
    expect(pickChangelogInDir([{ name: "README.md", type: "file" }])).toBeNull();
  });

  it("ignores dir entries named like CHANGELOG", () => {
    expect(pickChangelogInDir([{ name: "CHANGELOG.md", type: "dir" }])).toBeNull();
  });
});

describe("fetchChangelogFiles", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("returns root CHANGELOG only when no workspaces field", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "package.json", type: "file" },
        ]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/package.json")) {
        return text(JSON.stringify({ name: "solo" }));
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md")) {
        return text("# root changelog");
      }
      return new Response("not found", { status: 404 });
    });

    const files = await fetchChangelogFiles(mkSource());
    expect(files.map((f) => f.path)).toEqual(["CHANGELOG.md"]);
    expect(files[0].truncated).toBe(false);
  });

  it("resolves packages/* glob into per-package files", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "package.json", type: "file" },
          { name: "packages", type: "dir" },
        ]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/package.json")) {
        return text(JSON.stringify({ workspaces: ["packages/*", "apps/web"] }));
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md")) {
        return text("# root changelog");
      }
      if (url.endsWith("/repos/owner/repo/contents/packages")) {
        return json([
          { name: "alpha", type: "dir" },
          { name: "beta", type: "dir" },
        ]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages/alpha")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages/beta")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/apps/web")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/packages/alpha/CHANGELOG.md")) {
        return text("# alpha");
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/packages/beta/CHANGELOG.md")) {
        return text("# beta");
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/apps/web/CHANGELOG.md")) {
        return text("# web");
      }
      return new Response("not found", { status: 404 });
    });

    const files = await fetchChangelogFiles(mkSource());
    const paths = files.map((f) => f.path).toSorted();
    expect(paths).toEqual([
      "CHANGELOG.md",
      "apps/web/CHANGELOG.md",
      "packages/alpha/CHANGELOG.md",
      "packages/beta/CHANGELOG.md",
    ]);
  });

  it("honors metadata.changelogPaths override", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "package.json", type: "file" },
        ]);
      }
      if (url.endsWith("/repos/owner/repo/contents/custom/dir")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md")) {
        return text("# root");
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/custom/dir/CHANGELOG.md")) {
        return text("# custom");
      }
      return new Response("not found", { status: 404 });
    });

    const files = await fetchChangelogFiles(
      mkSource({
        metadata: JSON.stringify({ changelogPaths: ["custom/dir/CHANGELOG.md"] }),
      }),
    );
    const paths = files.map((f) => f.path).toSorted();
    expect(paths).toEqual(["CHANGELOG.md", "custom/dir/CHANGELOG.md"]);
  });

  it("skips override entries that don't exist on HEAD", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "package.json", type: "file" },
          { name: "missing", type: "dir" },
        ]);
      }
      if (url.endsWith("/repos/owner/repo/contents/missing")) {
        return json([{ name: "README.md", type: "file" }]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md")) {
        return text("# root");
      }
      return new Response("not found", { status: 404 });
    });

    const files = await fetchChangelogFiles(
      mkSource({
        metadata: JSON.stringify({ changelogPaths: ["missing/CHANGELOG.md"] }),
      }),
    );
    expect(files.map((f) => f.path)).toEqual(["CHANGELOG.md"]);
  });

  it("truncates content exceeding 1MB, keeps the suffix (recent entries), and flags truncated: true", async () => {
    // Simulate a CHANGELOG where the suffix (end of string) contains the
    // recent entries. We prefix with padding so total size exceeds the cap.
    const padding = "old entries\n".repeat(Math.ceil(CHANGELOG_MAX_BYTES / 12) + 100);
    const recent = "# Recent entry\n";
    const oversized = padding + recent;
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md")) {
        return text(oversized);
      }
      return new Response("not found", { status: 404 });
    });

    const files = await fetchChangelogFiles(mkSource());
    expect(files).toHaveLength(1);
    expect(files[0].truncated).toBe(true);
    expect(files[0].bytes).toBeLessThanOrEqual(CHANGELOG_MAX_BYTES);
    // The suffix is kept — the recent entry must be present in the output.
    expect(files[0].content.endsWith(recent)).toBe(true);
    // The prefix (old entries) should have been dropped.
    expect(files[0].content.startsWith("old entries")).toBe(false);
  });

  it("handles root listing failure without throwing", async () => {
    installFetch(() => new Response("nope", { status: 500 }));
    const files = await fetchChangelogFiles(mkSource());
    expect(files).toEqual([]);
  });
});

describe("parsePnpmWorkspaces", () => {
  it("parses a flat packages list", () => {
    const yaml = `packages:\n  - 'apps/*'\n  - "packages/*"\n  - tools/builder\n`;
    expect(parsePnpmWorkspaces(yaml)).toEqual(["apps/*", "packages/*", "tools/builder"]);
  });

  it("ignores comments and other top-level keys", () => {
    const yaml = `# header comment\npackages:\n  - apps/web   # inline comment\n  - apps/api\nlinkWorkspacePackages: true\n`;
    expect(parsePnpmWorkspaces(yaml)).toEqual(["apps/web", "apps/api"]);
  });

  it("returns [] when packages key absent", () => {
    expect(parsePnpmWorkspaces("name: solo\nversion: 1.0.0\n")).toEqual([]);
  });
});

describe("truncateToByteCap", () => {
  it("returns the content unchanged when it fits within the cap", () => {
    const content = "small content";
    const result = truncateToByteCap(content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.bytes).toBe(new TextEncoder().encode(content).length);
  });

  it("keeps the suffix (not the prefix) when truncating", () => {
    // Build a string that exceeds the cap: a long prefix of junk + a short
    // distinct tail. After truncation the tail must survive.
    const tail = "## v99.0.0 — recent release\n";
    const filler = "a".repeat(CHANGELOG_MAX_BYTES + 100);
    const input = filler + tail;
    const result = truncateToByteCap(input);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(CHANGELOG_MAX_BYTES);
    expect(result.content.endsWith(tail)).toBe(true);
  });

  it("does not produce a partial multi-byte code point at the boundary", () => {
    // Build a string just under the cap of all ASCII, then append a 3-byte
    // UTF-8 character (e.g. U+2603 SNOWMAN, encoded as 0xE2 0x98 0x83) so
    // that the total byte length straddles the cap.
    const snowman = "☃"; // 3 bytes in UTF-8
    const asciiPad = "x".repeat(CHANGELOG_MAX_BYTES - 2); // cap - 2 bytes → fits 1 byte short of cap
    const input = asciiPad + snowman; // total = cap + 1 byte → must truncate
    const encoder = new TextEncoder();
    expect(encoder.encode(input).length).toBeGreaterThan(CHANGELOG_MAX_BYTES);

    const result = truncateToByteCap(input);
    expect(result.truncated).toBe(true);
    // Verify round-trip: decoding the output produces valid Unicode (no replacement chars).
    const decoded = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoded.decode(encoder.encode(result.content))).not.toThrow();
    expect(result.bytes).toBeLessThanOrEqual(CHANGELOG_MAX_BYTES);
  });
});

describe("discoverChangelogPaths", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("reports root + per-package paths with origin tags", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "package.json", type: "file" },
          { name: "packages", type: "dir" },
        ]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/package.json")) {
        return text(JSON.stringify({ workspaces: ["packages/*"] }));
      }
      if (url.endsWith("/repos/owner/repo/contents/packages")) {
        return json([{ name: "alpha", type: "dir" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages/alpha")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const planned = await discoverChangelogPaths(mkSource());
    expect(planned).toEqual([
      { path: "CHANGELOG.md", origin: "root", exists: true },
      { path: "packages/alpha/CHANGELOG.md", origin: "workspace", exists: true },
    ]);
  });

  it("reports override entries with existence resolved via parent dir listing", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "real", type: "dir" },
        ]);
      }
      if (url.endsWith("/repos/owner/repo/contents/real")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/missing")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });

    const planned = await discoverChangelogPaths(
      mkSource({
        metadata: JSON.stringify({
          changelogPaths: ["real/CHANGELOG.md", "missing/CHANGELOG.md"],
        }),
      }),
    );
    expect(planned).toEqual([
      { path: "CHANGELOG.md", origin: "root", exists: true },
      { path: "real/CHANGELOG.md", origin: "override", exists: true },
      { path: "missing/CHANGELOG.md", origin: "override", exists: false },
    ]);
  });

  it("expands pnpm-workspace.yaml as a workspace declaration (origin: workspace)", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "pnpm-workspace.yaml", type: "file" },
          { name: "packages", type: "dir" },
        ]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/pnpm-workspace.yaml")) {
        return text("packages:\n  - 'packages/*'\n");
      }
      if (url.endsWith("/repos/owner/repo/contents/packages")) {
        return json([{ name: "core", type: "dir" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages/core")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const planned = await discoverChangelogPaths(mkSource());
    expect(planned).toEqual([
      {
        path: "packages/core/CHANGELOG.md",
        origin: "workspace",
        exists: true,
      },
    ]);
  });

  it("merges npm and pnpm workspace declarations when both are present", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/repo/contents/")) {
        return json([
          { name: "package.json", type: "file" },
          { name: "pnpm-workspace.yaml", type: "file" },
          { name: "apps", type: "dir" },
          { name: "packages", type: "dir" },
        ]);
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/package.json")) {
        return text(JSON.stringify({ workspaces: ["apps/*"] }));
      }
      if (url.endsWith("raw.githubusercontent.com/owner/repo/HEAD/pnpm-workspace.yaml")) {
        return text("packages:\n  - 'packages/*'\n");
      }
      if (url.endsWith("/repos/owner/repo/contents/apps")) {
        return json([{ name: "web", type: "dir" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/apps/web")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages")) {
        return json([{ name: "core", type: "dir" }]);
      }
      if (url.endsWith("/repos/owner/repo/contents/packages/core")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const planned = await discoverChangelogPaths(mkSource());
    const paths = planned.map((p) => p.path).toSorted();
    expect(paths).toEqual(["apps/web/CHANGELOG.md", "packages/core/CHANGELOG.md"]);
    for (const p of planned) expect(p.origin).toBe("workspace");
  });
});

describe("evaluateTagFilter", () => {
  it("returns no-filter when neither denyPrefixes nor allowPatterns are set", () => {
    expect(evaluateTagFilter("v1.0.0", undefined, undefined)).toBe("no-filter");
  });

  it("returns no-filter when both arrays are empty", () => {
    expect(evaluateTagFilter("v1.0.0", [], [])).toBe("no-filter");
  });

  it("returns deny when tag matches a deny prefix", () => {
    expect(evaluateTagFilter("agent-skills-v0.91.0", ["agent-skills-", "hog-"], undefined)).toBe(
      "deny",
    );
  });

  it("returns deny for hog- prefix", () => {
    expect(evaluateTagFilter("hog-v1.2.3", ["agent-skills-", "hog-"], undefined)).toBe("deny");
  });

  it("returns no-filter when tag does not match any deny prefix", () => {
    expect(evaluateTagFilter("v1.0.0", ["agent-skills-", "hog-"], undefined)).toBe("no-filter");
  });

  it("deny prefix match is case-sensitive", () => {
    expect(evaluateTagFilter("Agent-Skills-v1.0", ["agent-skills-"], undefined)).toBe("no-filter");
  });

  it("returns allow when tag matches an allow pattern", () => {
    expect(evaluateTagFilter("v1.2.3", undefined, ["^v\\d+"])).toBe("allow");
  });

  it("returns allow-miss when tag does not match any allow pattern", () => {
    expect(evaluateTagFilter("agent-skills-v0.91.0", undefined, ["^v\\d+"])).toBe("allow-miss");
  });

  it("allow-patterns wins over deny-prefixes when both are set", () => {
    // Even though "agent-skills-" is a deny prefix, allowPatterns takes sole
    // control — the deny list is ignored entirely.
    expect(evaluateTagFilter("agent-skills-v0.91.0", ["agent-skills-"], ["^agent-skills-"])).toBe(
      "allow",
    );
  });

  it("allow-miss fires even when tag would match a deny prefix (allow-patterns wins)", () => {
    // "hog-v1.0" would be denied by the deny list, but allow-patterns is set
    // and the tag doesn't match — so result is allow-miss, not deny.
    expect(evaluateTagFilter("hog-v1.0", ["hog-"], ["^v\\d+"])).toBe("allow-miss");
  });

  it("treats an invalid regex pattern as non-matching and returns allow-miss (does not throw)", () => {
    expect(() => evaluateTagFilter("v1.0.0", undefined, ["[unclosed"])).not.toThrow();
    expect(evaluateTagFilter("v1.0.0", undefined, ["[unclosed"])).toBe("allow-miss");
  });

  it("with mixed valid + invalid patterns, a tag matching the valid one is allowed", () => {
    expect(evaluateTagFilter("v1.2.3", undefined, ["[unclosed", "^v\\d+"])).toBe("allow");
  });

  it("with mixed valid + invalid patterns, a tag matching neither falls through to allow-miss", () => {
    expect(evaluateTagFilter("agent-skills-v0.91.0", undefined, ["[unclosed", "^v\\d+"])).toBe(
      "allow-miss",
    );
  });

  it("invokes onInvalidPattern once per bad pattern with the offending string", () => {
    const seen: Array<{ pattern: string; message: string }> = [];
    const result = evaluateTagFilter("v1.0.0", undefined, ["[unclosed", "^v\\d+"], (pattern, err) =>
      seen.push({
        pattern,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    expect(result).toBe("allow");
    expect(seen).toHaveLength(1);
    expect(seen[0].pattern).toBe("[unclosed");
    expect(seen[0].message.length).toBeGreaterThan(0);
  });
});

describe("github.fetch tag filtering", () => {
  afterEach(() => {
    restoreFetch();
  });

  function makeGitHubRelease(tag: string, body = "content") {
    return {
      tag_name: tag,
      name: tag,
      body,
      html_url: `https://github.com/owner/repo/releases/tag/${tag}`,
      published_at: "2026-01-01T00:00:00Z",
      prerelease: false,
    };
  }

  it("passes all releases when no filter is configured", async () => {
    installFetch((url) => {
      if (url.includes("/repos/owner/repo/releases")) {
        return json([makeGitHubRelease("v1.0.0"), makeGitHubRelease("v2.0.0")]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await github.fetch(mkSource());
    expect(result.releases.map((r) => r.version)).toEqual(["v1.0.0", "v2.0.0"]);
  });

  it("skips tags matching a deny prefix", async () => {
    installFetch((url) => {
      if (url.includes("/repos/owner/repo/releases")) {
        return json([
          makeGitHubRelease("v1.0.0"),
          makeGitHubRelease("agent-skills-v0.91.0"),
          makeGitHubRelease("hog-v1.0"),
          makeGitHubRelease("v2.0.0"),
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await github.fetch(
      mkSource({ metadata: JSON.stringify({ tagDenyPrefixes: ["agent-skills-", "hog-"] }) }),
    );
    expect(result.releases.map((r) => r.version)).toEqual(["v1.0.0", "v2.0.0"]);
  });

  it("skips tags not matching any allow pattern", async () => {
    installFetch((url) => {
      if (url.includes("/repos/owner/repo/releases")) {
        return json([
          makeGitHubRelease("v1.0.0"),
          makeGitHubRelease("agent-skills-v0.91.0"),
          makeGitHubRelease("v2.0.0"),
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await github.fetch(
      mkSource({ metadata: JSON.stringify({ tagAllowPatterns: ["^v\\d+"] }) }),
    );
    expect(result.releases.map((r) => r.version)).toEqual(["v1.0.0", "v2.0.0"]);
  });

  it("allow-patterns takes precedence over deny-prefixes when both are set", async () => {
    installFetch((url) => {
      if (url.includes("/repos/owner/repo/releases")) {
        return json([makeGitHubRelease("v1.0.0"), makeGitHubRelease("agent-skills-v0.91.0")]);
      }
      return new Response("not found", { status: 404 });
    });

    // deny list would block "v1.0.0" (starts with "v"), but allow-patterns
    // override means only the allow-pattern decides.
    const result = await github.fetch(
      mkSource({
        metadata: JSON.stringify({
          tagDenyPrefixes: ["agent-skills-"],
          tagAllowPatterns: ["^agent-skills-"],
        }),
      }),
    );
    // allow-pattern matches agent-skills-* and misses v1.0.0
    expect(result.releases.map((r) => r.version)).toEqual(["agent-skills-v0.91.0"]);
  });

  it("does not throw when allow-patterns contains an invalid regex; valid patterns still match", async () => {
    installFetch((url) => {
      if (url.includes("/repos/owner/repo/releases")) {
        return json([
          makeGitHubRelease("v1.0.0"),
          makeGitHubRelease("v2.0.0"),
          makeGitHubRelease("agent-skills-v0.91.0"),
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    // One bad pattern paired with a valid one: the fetch must complete and
    // releases matching the valid pattern still get through.
    const result = await github.fetch(
      mkSource({
        metadata: JSON.stringify({
          tagAllowPatterns: ["[unclosed", "^v\\d+"],
        }),
      }),
    );
    expect(result.releases.map((r) => r.version)).toEqual(["v1.0.0", "v2.0.0"]);
  });
});
