import { describe, it, expect, afterEach } from "bun:test";
import { changelogRoutes } from "../src/routes/changelog.js";
import type { Env } from "../src/index.js";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

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
  capped: boolean;
  format: string | null;
  file: { path: string; truncated: boolean } | null;
  releases: { version: string | null; title: string; publishedAt: string | null }[];
  stats: { releasesParsed: number; githubRequests: number };
};

type GitHubReleaseRow = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
};

/** Build a GitHub Releases API row with sane defaults. */
function ghRelease(over: Partial<GitHubReleaseRow> = {}): GitHubReleaseRow {
  return {
    tag_name: "v1.0.0",
    name: null,
    body: "- a change",
    html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
    published_at: "2026-01-01T00:00:00Z",
    prerelease: false,
    ...over,
  };
}

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

  it("auto: prefers CHANGELOG.md when releases exist but have empty bodies", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) {
        // releases exist but body-less → hasBody is false → fall through to the file
        return json([
          {
            tag_name: "v1.0.0",
            name: null,
            body: "",
            html_url: "h",
            published_at: null,
            prerelease: false,
          },
        ]);
      }
      if (url === TREE_URL) {
        return json({ truncated: false, tree: [{ path: "CHANGELOG.md", type: "blob", size: 40 }] });
      }
      if (url === ROOT_CHANGELOG) return text("## [2.0.0] - 2026-02-02\n- real notes");
      return new Response("nf", { status: 404 });
    });

    const res = await call({ repo: "owner/repo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("changelog_file");
    expect(body.releases[0].version).toBe("2.0.0");
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
        return json([
          {
            tag_name: "v9",
            name: null,
            body: "x",
            html_url: "h",
            published_at: null,
            prerelease: false,
          },
        ]);
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

  it("returns 400 for a non-github coordinate", async () => {
    installFetch(() => json({}));
    const res = await call({ repo: "npm:left-pad" });
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

  it("source=github_releases: surfaces an upstream releases failure as 502", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({}); // precheck OK
      if (url === RELEASES_URL) return new Response("boom", { status: 500 }); // sub-call fails
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo", source: "github_releases" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("github_upstream_error");
  });

  it("source=changelog_file: surfaces a raw body fetch failure as 502", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({}); // precheck OK
      if (url === TREE_URL) {
        return json({ truncated: false, tree: [{ path: "CHANGELOG.md", type: "blob", size: 50 }] });
      }
      if (url === ROOT_CHANGELOG) return new Response("boom", { status: 500 }); // body fetch fails
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo", source: "changelog_file" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("github_upstream_error");
  });

  it("auto: degrades past a releases failure to CHANGELOG.md (no error surfaced)", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({}); // precheck OK
      if (url === RELEASES_URL) return new Response("boom", { status: 500 }); // releases fail
      if (url === TREE_URL) {
        return json({ truncated: false, tree: [{ path: "CHANGELOG.md", type: "blob", size: 50 }] });
      }
      if (url === ROOT_CHANGELOG) return text("## [3.0.0] - 2026-03-03\n- via fallback");
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.source).toBe("changelog_file");
    expect(body.releases[0].version).toBe("3.0.0");
    // changelog_file source is never capped (the whole file is parsed).
    expect(body.capped).toBe(false);
  });

  it("github_releases: re-sorts releases by published_at descending", async () => {
    // Returned out of order (GitHub's default created_at order can diverge from
    // publish order); the handler must re-sort newest-first.
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) {
        return json([
          ghRelease({ tag_name: "v2.1.0", published_at: "2026-02-01T00:00:00Z" }),
          ghRelease({ tag_name: "v3.0.0", published_at: "2026-05-01T00:00:00Z" }),
          ghRelease({ tag_name: "v2.0.0", published_at: "2026-01-01T00:00:00Z" }),
          ghRelease({ tag_name: "v2.5.0", published_at: "2026-03-01T00:00:00Z" }),
        ]);
      }
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo", source: "github_releases" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.releases.map((r) => r.version)).toEqual(["v3.0.0", "v2.5.0", "v2.1.0", "v2.0.0"]);
    expect(body.capped).toBe(false);
  });

  it("github_releases: sets capped when a full page (100) is returned", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) =>
      ghRelease({
        tag_name: `v1.0.${i}`,
        published_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
      }),
    );
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) return json(hundred);
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo", source: "github_releases" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.releases.length).toBe(100);
    expect(body.capped).toBe(true);
    // Newest-first after the re-sort: v1.0.99 was published last.
    expect(body.releases[0].version).toBe("v1.0.99");
  });

  it("github_releases: not capped just under the page size", async () => {
    const ninetyNine = Array.from({ length: 99 }, (_, i) => ghRelease({ tag_name: `v1.0.${i}` }));
    installFetch((url) => {
      if (url === "https://api.github.com/repos/owner/repo") return json({});
      if (url === RELEASES_URL) return json(ninetyNine);
      return new Response("nf", { status: 404 });
    });
    const res = await call({ repo: "owner/repo", source: "github_releases" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ParseBody;
    expect(body.releases.length).toBe(99);
    expect(body.capped).toBe(false);
  });
});
