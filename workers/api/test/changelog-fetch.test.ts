import { describe, it, expect, afterEach } from "bun:test";
import { changelogRoutes } from "../src/routes/changelog.js";
import type { Env } from "../src/index.js";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

// The route only reads `c.env.GITHUB_TOKEN` (via getSecret, which returns null
// for an undefined binding → anonymous GitHub access). Nothing else on Env is
// touched, so an empty bindings object is a sufficient test env.
const TEST_ENV = {} as Env["Bindings"];

type FetchHandler = (url: string) => Response | Promise<Response>;

function installFetch(handler: FetchHandler) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url);
  }) as typeof fetch;
}

afterEach(() => {
  restoreGlobalFetch();
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

function call(repo: unknown) {
  return changelogRoutes.request(
    "/changelog/fetch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo }),
    },
    TEST_ENV,
  );
}

// A small monorepo whose recursive tree carries a root CHANGELOG, a per-package
// CHANGELOG, a non-changelog source file, and a vendored CHANGELOG under
// node_modules. Exercises the tree-search discovery, noise filtering, two body
// fetches, and the request counter end-to-end.
function monorepoHandler(url: string): Response {
  switch (url) {
    case "https://api.github.com/repos/owner/repo":
      return json({ full_name: "owner/repo" });
    case "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1":
      return json({
        truncated: false,
        tree: [
          { path: "CHANGELOG.md", type: "blob", size: 100 },
          { path: "packages", type: "tree" },
          { path: "packages/core", type: "tree" },
          { path: "packages/core/CHANGELOG.md", type: "blob", size: 50 },
          { path: "packages/core/src/index.ts", type: "blob", size: 9 },
          { path: "node_modules/dep/CHANGELOG.md", type: "blob", size: 7 },
        ],
      });
    case "https://raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md":
      return text("# Root\n\n## 2.0.0\n- big change");
    case "https://raw.githubusercontent.com/owner/repo/HEAD/packages/core/CHANGELOG.md":
      return text("# core\n\n## 0.1.0\n- first");
    default:
      return new Response("not found", { status: 404 });
  }
}

describe("POST /changelog/fetch", () => {
  type FetchBody = {
    repo: string;
    files: {
      path: string;
      origin: string;
      size: number | null;
      fetched: boolean;
      excerpt: string | null;
      truncated: boolean;
    }[];
    stats: {
      pathsDiscovered: number;
      filesFetched: number;
      totalBytes: number;
      inventoryBytes: number;
      truncatedCount: number;
      githubRequests: number;
      elapsedMs: number;
    };
  };

  it("discovers tree changelogs (excluding noise) and reports accurate stats", async () => {
    installFetch(monorepoHandler);
    const res = await call("owner/repo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FetchBody;

    expect(body.repo).toBe("owner/repo");
    const paths = body.files.map((f) => f.path).sort();
    // node_modules CHANGELOG and the .ts source file are filtered out.
    expect(paths).toEqual(["CHANGELOG.md", "packages/core/CHANGELOG.md"]);

    const root = body.files.find((f) => f.path === "CHANGELOG.md");
    expect(root?.origin).toBe("root");
    expect(root?.size).toBe(100); // carried from the tree, not the downloaded body
    expect(root?.fetched).toBe(true);
    expect(root?.excerpt).toContain("## 2.0.0");
    expect(body.files.find((f) => f.path === "packages/core/CHANGELOG.md")?.origin).toBe(
      "workspace",
    );

    expect(body.stats.pathsDiscovered).toBe(2);
    expect(body.stats.filesFetched).toBe(2);
    expect(body.stats.truncatedCount).toBe(0);
    expect(body.stats.totalBytes).toBeGreaterThan(0);
    expect(body.stats.inventoryBytes).toBe(150); // 100 + 50 from the tree sizes
    // 1 precheck + 1 recursive tree call + 2 body fetches.
    expect(body.stats.githubRequests).toBe(4);
    expect(body.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the full inventory but caps body fetches (excerpts) at the limit", async () => {
    // 1 root + 21 nested changelogs = 22 discovered; only the first 20 (root +
    // 19 shallowest) get bodies fetched, the rest are inventory-only.
    installFetch((url) => {
      if (url === "https://api.github.com/repos/big/repo") return json({});
      if (url === "https://api.github.com/repos/big/repo/git/trees/HEAD?recursive=1") {
        const tree: { path: string; type: string; size: number }[] = [
          { path: "CHANGELOG.md", type: "blob", size: 10 },
        ];
        for (let i = 0; i < 21; i++) {
          tree.push({
            path: `packages/p${String(i).padStart(2, "0")}/CHANGELOG.md`,
            type: "blob",
            size: 5,
          });
        }
        return json({ truncated: false, tree });
      }
      if (url.startsWith("https://raw.githubusercontent.com/big/repo/HEAD/")) {
        return text("# changelog\n- entry");
      }
      return new Response("nf", { status: 404 });
    });

    const res = await call("big/repo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FetchBody;

    expect(body.files).toHaveLength(22); // full inventory
    expect(body.stats.pathsDiscovered).toBe(22);
    expect(body.stats.filesFetched).toBe(20); // capped
    expect(body.stats.inventoryBytes).toBe(10 + 21 * 5);
    // 1 precheck + 1 tree call + 20 body fetches.
    expect(body.stats.githubRequests).toBe(22);

    const unfetched = body.files.filter((f) => !f.fetched);
    expect(unfetched).toHaveLength(2);
    expect(unfetched.every((f) => f.excerpt === null && f.size !== null)).toBe(true);
  });

  it("returns 400 when repo is missing", async () => {
    installFetch(monorepoHandler);
    const res = await call(undefined);
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { error: { code: string; type: string; message: string } }).error.code,
    ).toBe("bad_request");
  });

  it("returns 400 for a non-github coordinate", async () => {
    installFetch(monorepoHandler);
    const res = await call("npm:left-pad");
    expect(res.status).toBe(400);
  });

  it("maps a missing repo to 404 via the precheck", async () => {
    installFetch((url) =>
      url === "https://api.github.com/repos/ghost/repo"
        ? new Response("nope", { status: 404 })
        : json({}),
    );
    const res = await call("ghost/repo");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("maps GitHub rate-limiting to 503", async () => {
    installFetch((url) =>
      url === "https://api.github.com/repos/busy/repo"
        ? new Response("slow down", { status: 429 })
        : json({}),
    );
    const res = await call("busy/repo");
    expect(res.status).toBe(503);
  });

  it("maps a rate-limit 403 (x-ratelimit-remaining: 0) to 503", async () => {
    installFetch((url) =>
      url === "https://api.github.com/repos/busy/repo"
        ? new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
        : json({}),
    );
    const res = await call("busy/repo");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "service_unavailable",
    );
  });

  it("maps an auth 403 (no rate-limit header) to 502", async () => {
    installFetch((url) =>
      url === "https://api.github.com/repos/private/repo"
        ? new Response("forbidden", { status: 403, headers: { "x-ratelimit-remaining": "57" } })
        : json({}),
    );
    const res = await call("private/repo");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
  });
});
