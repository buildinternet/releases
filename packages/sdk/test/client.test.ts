import { describe, expect, test } from "bun:test";
import { Releases, ReleasesError } from "../src/index.js";

type Captured = { url: string; init: RequestInit };

function client(response: () => Response, options: { apiKey?: string; baseUrl?: string } = {}) {
  const calls: Captured[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof globalThis.fetch;
  return { sdk: new Releases({ ...options, fetch }), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Releases client", () => {
  test("builds the URL from path params and skips undefined query values", async () => {
    const { sdk, calls } = client(() =>
      json({ releases: [], pagination: { nextCursor: null, limit: 5 } }),
    );
    await sdk.orgs.releases("next js", { limit: 5, cursor: undefined, include_prereleases: false });
    expect(calls[0]!.url).toBe(
      "https://api.releases.sh/v1/orgs/next%20js/releases?limit=5&include_prereleases=false",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("sends the API key as a Bearer token, only when set", async () => {
    const anon = client(() => json({ releases: [] }));
    await anon.sdk.releases.latest();
    expect((anon.calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();

    const authed = client(() => json({ releases: [] }), { apiKey: "relu_abc" });
    await authed.sdk.releases.latest();
    expect((authed.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer relu_abc",
    );
  });

  test("routes a source slug pair to the org-scoped path", async () => {
    const { sdk, calls } = client(() => json({ inserted: 1, total: 1, insertedIds: ["rel_1"] }));
    const res = await sdk.sources.publish(
      { org: "acme", source: "cli" },
      { mode: "upsert-content", releases: [{ title: "v1", content: "Notes" }] },
      { idempotencyKey: "k1" },
    );
    expect(res.insertedIds).toEqual(["rel_1"]);
    expect(calls[0]!.url).toBe("https://api.releases.sh/v1/orgs/acme/sources/cli/releases/batch");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(calls[0]!.init.body as string).mode).toBe("upsert-content");
  });

  test("returns undefined for 204", async () => {
    const { sdk } = client(() => new Response(null, { status: 204 }));
    expect(await sdk.me.webhooks.delete("wh_1")).toBeUndefined();
  });

  test("throws ReleasesError with the envelope's code and type", async () => {
    const { sdk } = client(() =>
      json({ error: { code: "not_found", type: "not_found", message: "Org not found" } }, 404),
    );
    const err = await sdk.orgs.get("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleasesError);
    expect(err).toMatchObject({
      status: 404,
      code: "not_found",
      type: "not_found",
      message: "Org not found",
      method: "GET",
      path: "/orgs/nope",
    });
  });

  test("wraps a non-envelope error body and network failures", async () => {
    const { sdk } = client(
      () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(sdk.stats()).rejects.toMatchObject({ status: 502, type: "internal" });

    const failing = new Releases({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(failing.stats()).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  test("honours a custom base URL", async () => {
    const { sdk, calls } = client(() => json({}), { baseUrl: "https://staging.example.com/" });
    await sdk.workspaceWebhooks("ws_1").deliveries("wh_1", { failed: true });
    expect(calls[0]!.url).toBe(
      "https://staging.example.com/v1/workspaces/ws_1/webhooks/wh_1/deliveries?failed=true",
    );
  });

  test("rejects a missing path parameter", async () => {
    const { sdk } = client(() => json({}));
    await expect(sdk.releases.get("")).rejects.toThrow('Missing path parameter "id"');
  });
});
