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
