import { describe, it, expect, afterEach } from "bun:test";
import {
  fetchChangelogFiles,
  parseWorkspaces,
  pickChangelogInDir,
  CHANGELOG_MAX_BYTES,
} from "../../src/adapters/github.js";
import type { Source } from "../../src/db/schema.js";

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
    expect(
      parseWorkspaces(JSON.stringify({ workspaces: { packages: ["libs/*"] } })),
    ).toEqual(["libs/*"]);
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
    expect(
      pickChangelogInDir([{ name: "CHANGELOG.md", type: "dir" }]),
    ).toBeNull();
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
    const paths = files.map((f) => f.path).sort();
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
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["CHANGELOG.md", "custom/dir/CHANGELOG.md"]);
  });

  it("truncates content exceeding 1MB and flags truncated: true", async () => {
    const oversized = "x".repeat(CHANGELOG_MAX_BYTES + 1024);
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
    expect(files[0].bytes).toBe(CHANGELOG_MAX_BYTES);
    expect(files[0].content.length).toBe(CHANGELOG_MAX_BYTES);
  });

  it("handles root listing failure without throwing", async () => {
    installFetch(() => new Response("nope", { status: 500 }));
    const files = await fetchChangelogFiles(mkSource());
    expect(files).toEqual([]);
  });
});
