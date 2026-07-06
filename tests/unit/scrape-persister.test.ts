import { describe, expect, test } from "bun:test";
import { httpPersister } from "@releases/adapters/scrape-persister";

function recordingFetcher(responses: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        const body = responses[new URL(url).pathname];
        return body === undefined
          ? new Response("not found", { status: 404 })
          : Response.json(body);
      },
    },
  };
}

const SOURCE = { id: "src_x", orgId: "org_y", slug: "s", type: "scrape" } as never;

describe("httpPersister", () => {
  test("insertReleases POSTs batch and returns inserted + insertedIds", async () => {
    const { calls, fetcher } = recordingFetcher({
      "/v1/orgs/org_y/sources/src_x/releases/batch": {
        inserted: 2,
        total: 10,
        insertedIds: ["rel_a", "rel_b"],
      },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const res = await p.insertReleases(SOURCE, [
      { title: "t1", content: "c1" } as never,
      { title: "t2", content: "c2" } as never,
    ]);
    expect(res).toEqual({ inserted: 2, insertedIds: ["rel_a", "rel_b"] });
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("insertReleases tolerates responses without insertedIds (pre-extension API)", async () => {
    const { fetcher } = recordingFetcher({
      "/v1/orgs/org_y/sources/src_x/releases/batch": { inserted: 1, total: 3 },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const res = await p.insertReleases(SOURCE, [{ title: "t", content: "c" } as never]);
    expect(res).toEqual({ inserted: 1, insertedIds: [] });
  });

  test("writeFetchLog is best-effort (rejecting fetch does not throw) and strips nothing the route needs", async () => {
    const p = httpPersister({
      apiFetcher: { fetch: async () => Promise.reject(new Error("down")) },
      apiKey: "k",
    });
    await expect(
      p.writeFetchLog("src_x", {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 1,
        status: "no_change",
        wasFlagged: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("captureRawSnapshot no-ops when captureRawSnapshots is off", async () => {
    const { calls, fetcher } = recordingFetcher({});
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k", captureRawSnapshots: false });
    await p.captureRawSnapshot(SOURCE, "body");
    expect(calls).toHaveLength(0);
  });

  test("getSource routes a src_ id to the typed-id endpoint", async () => {
    const { calls, fetcher } = recordingFetcher({
      "/v1/sources/src_abc": { id: "src_abc", orgId: "org_y", slug: "s", type: "scrape" },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const src = await p.getSource("src_abc");
    expect(src?.id).toBe("src_abc");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/sources/src_abc");
  });

  test("getSource routes an org/slug coordinate to the org-scoped endpoint", async () => {
    const { calls, fetcher } = recordingFetcher({
      "/v1/orgs/acme/sources/changelog": {
        id: "src_c",
        orgId: "org_a",
        slug: "changelog",
        type: "scrape",
      },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const src = await p.getSource("acme/changelog");
    expect(src?.slug).toBe("changelog");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orgs/acme/sources/changelog");
  });

  test("getSource routes a bare slug to the legacy endpoint and maps 404 to null", async () => {
    const { calls, fetcher } = recordingFetcher({});
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const src = await p.getSource("just-a-slug");
    expect(src).toBeNull();
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/sources/just-a-slug");
  });

  test("getKnownReleases GETs the known-releases subresource and maps errors to []", async () => {
    const { calls, fetcher } = recordingFetcher({
      "/v1/orgs/org_y/sources/src_x/known-releases": [{ title: "t", version: "1.0", url: "u" }],
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const known = await p.getKnownReleases(SOURCE);
    expect(known).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/orgs/org_y/sources/src_x/known-releases");
    expect(u.searchParams.get("limit")).toBe("10");

    const failing = httpPersister({
      apiFetcher: { fetch: async () => new Response("boom", { status: 500 }) },
      apiKey: "k",
    });
    expect(await failing.getKnownReleases(SOURCE)).toEqual([]);
  });

  test("updateSourceAfterFetch PATCHes the counter-reset payload", async () => {
    const { calls, fetcher } = recordingFetcher({ "/v1/orgs/org_y/sources/src_x": {} });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    await p.updateSourceAfterFetch(SOURCE);
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent).toMatchObject({
      changeDetectedAt: null,
      consecutiveErrors: 0,
      consecutiveNoChange: 0,
      nextFetchAfter: null,
    });
    expect(typeof sent.lastFetchedAt).toBe("string");
  });
});
