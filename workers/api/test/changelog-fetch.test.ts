import { describe, it, expect, afterEach } from "bun:test";
import { changelogRoutes } from "../src/routes/changelog.js";
import type { Env } from "../src/index.js";

// The route only reads `c.env.GITHUB_TOKEN` (via getSecret, which returns null
// for an undefined binding → anonymous GitHub access). Nothing else on Env is
// touched, so an empty bindings object is a sufficient test env.
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

// A small monorepo: root CHANGELOG + a package.json workspace whose one package
// (packages/core) also has a CHANGELOG. Exercises root listing, workspace glob
// expansion, two body fetches, and the request counter end-to-end.
function monorepoHandler(url: string): Response {
  switch (url) {
    case "https://api.github.com/repos/owner/repo":
      return json({ full_name: "owner/repo" });
    case "https://api.github.com/repos/owner/repo/contents/":
      return json([
        { name: "CHANGELOG.md", type: "file" },
        { name: "package.json", type: "file" },
        { name: "packages", type: "dir" },
      ]);
    case "https://raw.githubusercontent.com/owner/repo/HEAD/package.json":
      return text(JSON.stringify({ workspaces: ["packages/*"] }));
    case "https://api.github.com/repos/owner/repo/contents/packages":
      return json([{ name: "core", type: "dir" }]);
    case "https://api.github.com/repos/owner/repo/contents/packages/core":
      return json([{ name: "CHANGELOG.md", type: "file" }]);
    case "https://raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md":
      return text("# Root\n\n## 2.0.0\n- big change");
    case "https://raw.githubusercontent.com/owner/repo/HEAD/packages/core/CHANGELOG.md":
      return text("# core\n\n## 0.1.0\n- first");
    default:
      return new Response("not found", { status: 404 });
  }
}

describe("POST /changelog/fetch", () => {
  it("discovers root + workspace changelogs and reports accurate stats", async () => {
    installFetch(monorepoHandler);
    const res = await call("owner/repo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: string;
      files: { path: string; origin: string; bytes: number; excerpt: string }[];
      stats: {
        pathsDiscovered: number;
        filesFetched: number;
        totalBytes: number;
        truncatedCount: number;
        githubRequests: number;
        elapsedMs: number;
      };
    };

    expect(body.repo).toBe("owner/repo");
    const paths = body.files.map((f) => f.path).sort();
    expect(paths).toEqual(["CHANGELOG.md", "packages/core/CHANGELOG.md"]);
    expect(body.files.find((f) => f.path === "CHANGELOG.md")?.origin).toBe("root");
    expect(body.files.find((f) => f.path === "packages/core/CHANGELOG.md")?.origin).toBe(
      "workspace",
    );
    expect(body.files.find((f) => f.path === "CHANGELOG.md")?.excerpt).toContain("## 2.0.0");

    expect(body.stats.pathsDiscovered).toBe(2);
    expect(body.stats.filesFetched).toBe(2);
    expect(body.stats.truncatedCount).toBe(0);
    expect(body.stats.totalBytes).toBeGreaterThan(0);
    // 1 precheck + 4 discovery calls (root listing, package.json read,
    // packages/ listing, packages/core listing) + 2 body fetches.
    expect(body.stats.githubRequests).toBe(7);
    expect(body.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 400 when repo is missing", async () => {
    installFetch(monorepoHandler);
    const res = await call(undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
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
    expect(((await res.json()) as { error: string }).error).toBe("repo_not_found");
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
});
