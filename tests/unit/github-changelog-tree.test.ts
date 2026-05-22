import { describe, it, expect, afterEach } from "bun:test";
import {
  discoverChangelogPathsViaTree,
  buildGitHubHeaders,
  createListingCache,
} from "@releases/adapters/github-discovery";
import type { Source } from "@buildinternet/releases-core/schema";

function mkSource(url = "https://github.com/owner/repo"): Source {
  return { url, metadata: null } as unknown as Source;
}

type FetchHandler = (url: string) => Response;
let originalFetch: typeof fetch;
function installFetch(handler: FetchHandler) {
  originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input.toString())) as typeof fetch;
}
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TREE_URL = "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1";
const headers = buildGitHubHeaders(undefined, "test-ua");

describe("discoverChangelogPathsViaTree", () => {
  it("matches changelog blobs anywhere, sorts root-first, and counts one request", async () => {
    const cache = createListingCache();
    installFetch((url) =>
      url === TREE_URL
        ? json({
            truncated: false,
            tree: [
              { path: "packages/core/CHANGELOG.md", type: "blob" },
              { path: "CHANGELOG.md", type: "blob" },
              { path: "docs/CHANGES.md", type: "blob" },
              { path: "src/index.ts", type: "blob" },
              { path: "packages", type: "tree" },
            ],
          })
        : json({}, 404),
    );

    const out = await discoverChangelogPathsViaTree(mkSource(), headers, cache);
    expect(out?.map((p) => p.path)).toEqual([
      "CHANGELOG.md", // depth 1 (root)
      "docs/CHANGES.md", // depth 2
      "packages/core/CHANGELOG.md", // depth 3
    ]);
    expect(out?.find((p) => p.path === "CHANGELOG.md")?.origin).toBe("root");
    expect(out?.find((p) => p.path === "docs/CHANGES.md")?.origin).toBe("workspace");
    expect(out?.every((p) => p.exists)).toBe(true);
    // The .ts source file is not a changelog and is excluded.
    expect(out?.some((p) => p.path === "src/index.ts")).toBe(false);
    // Single recursive tree call.
    expect(cache.requests).toBe(1);
  });

  it("excludes vendored / build / fixture directories", async () => {
    installFetch((url) =>
      url === TREE_URL
        ? json({
            truncated: false,
            tree: [
              { path: "CHANGELOG.md", type: "blob" },
              { path: "node_modules/dep/CHANGELOG.md", type: "blob" },
              { path: "vendor/lib/CHANGELOG.md", type: "blob" },
              { path: "dist/CHANGELOG.md", type: "blob" },
              { path: "test/fixtures/CHANGELOG.md", type: "blob" },
              { path: "examples/app/CHANGELOG.md", type: "blob" },
            ],
          })
        : json({}, 404),
    );
    const out = await discoverChangelogPathsViaTree(mkSource(), headers);
    expect(out?.map((p) => p.path)).toEqual(["CHANGELOG.md"]);
  });

  it("matches changelog filenames case-insensitively", async () => {
    installFetch((url) =>
      url === TREE_URL
        ? json({
            truncated: false,
            tree: [
              { path: "Changelog.md", type: "blob" },
              { path: "History.md", type: "blob" },
              { path: "readme.md", type: "blob" },
            ],
          })
        : json({}, 404),
    );
    const out = await discoverChangelogPathsViaTree(mkSource(), headers);
    expect(out?.map((p) => p.path).sort()).toEqual(["Changelog.md", "History.md"]);
  });

  it("falls back to the workspace walk when the tree is truncated", async () => {
    const cache = createListingCache();
    installFetch((url) => {
      if (url === TREE_URL) return json({ truncated: true, tree: [] });
      // Workspace-walk fallback: root contents listing with a CHANGELOG, no
      // package.json/workspaces → just the root file.
      if (url === "https://api.github.com/repos/owner/repo/contents/")
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      return json({}, 404);
    });
    const out = await discoverChangelogPathsViaTree(mkSource(), headers, cache);
    expect(out?.map((p) => p.path)).toEqual(["CHANGELOG.md"]);
    expect(out?.[0]?.origin).toBe("root");
    // 1 tree attempt + 1 fallback root listing.
    expect(cache.requests).toBe(2);
  });

  it("falls back to the workspace walk when the tree request fails", async () => {
    installFetch((url) => {
      if (url === TREE_URL) return json({ message: "boom" }, 500);
      if (url === "https://api.github.com/repos/owner/repo/contents/")
        return json([{ name: "HISTORY.md", type: "file" }]);
      return json({}, 404);
    });
    const out = await discoverChangelogPathsViaTree(mkSource(), headers);
    expect(out?.map((p) => p.path)).toEqual(["HISTORY.md"]);
  });

  it("returns null for a non-GitHub URL", async () => {
    installFetch(() => json({}, 404));
    expect(
      await discoverChangelogPathsViaTree(mkSource("https://example.com/x"), headers),
    ).toBeNull();
  });
});
