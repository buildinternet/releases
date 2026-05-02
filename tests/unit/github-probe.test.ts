import { describe, test, expect, afterEach, mock } from "bun:test";
import { probeRepo } from "../../packages/adapters/src/github-probe.js";

const TOKEN = "test-token";
const env = { GITHUB_TOKEN: TOKEN } as { GITHUB_TOKEN?: string };

const realFetch = globalThis.fetch;

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = mock((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(url.toString(), init)),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeRepo", () => {
  test("returns exists+hasReleases for a public repo with a release tag", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/repos/acme/foo/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (url.endsWith("/repos/acme/foo/contents/CHANGELOG.md")) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 404 });
    });

    const result = await probeRepo(env, "acme", "foo");
    expect(result).toEqual({
      exists: true,
      archived: false,
      hasReleases: true,
      hasChangelog: false,
      defaultBranch: "main",
      ownerLogin: null,
      repoName: null,
    });
  });

  test("captures canonical owner.login + repo.name from the probe response", async () => {
    // GitHub returns canonical case in the repo body; on-demand lookup
    // uses these to set org name and source name regardless of typed case.
    mockFetchOnce((url) => {
      if (url.toLowerCase().endsWith("/repos/shopify/toxiproxy")) {
        return new Response(
          JSON.stringify({
            archived: false,
            default_branch: "main",
            name: "toxiproxy",
            owner: { login: "Shopify" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/releases")) return new Response("[]", { status: 200 });
      if (url.includes("/contents/CHANGELOG.md")) return new Response("", { status: 404 });
      return new Response("", { status: 404 });
    });

    const result = await probeRepo(env, "SHOPIFY", "TOXIPROXY");
    expect(result.ownerLogin).toBe("Shopify");
    expect(result.repoName).toBe("toxiproxy");
  });

  test("returns hasChangelog when CHANGELOG.md exists", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/repos/acme/foo/releases?per_page=1")) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/repos/acme/foo/contents/CHANGELOG.md")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await probeRepo(env, "acme", "foo");
    expect(result.exists).toBe(true);
    expect(result.hasReleases).toBe(false);
    expect(result.hasChangelog).toBe(true);
  });

  test("returns exists=false on 404", async () => {
    mockFetchOnce(() => new Response("", { status: 404 }));
    const result = await probeRepo(env, "acme", "missing");
    expect(result.exists).toBe(false);
  });

  test("returns exists=false on 403 (private/forbidden)", async () => {
    mockFetchOnce(() => new Response("", { status: 403 }));
    const result = await probeRepo(env, "acme", "private");
    expect(result.exists).toBe(false);
  });

  test("returns archived=true for archived repos", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/old")) {
        return new Response(JSON.stringify({ archived: true, default_branch: "master" }), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
    const result = await probeRepo(env, "acme", "old");
    expect(result.archived).toBe(true);
  });

  test("throws ProbeRateLimitError on 429", async () => {
    mockFetchOnce(() => new Response("", { status: 429 }));
    await expect(probeRepo(env, "acme", "foo")).rejects.toMatchObject({
      name: "ProbeRateLimitError",
    });
  });

  test("throws ProbeServerError on 500", async () => {
    mockFetchOnce(() => new Response("", { status: 500 }));
    await expect(probeRepo(env, "acme", "foo")).rejects.toMatchObject({
      name: "ProbeServerError",
    });
  });
});
