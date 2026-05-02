import { describe, it, expect } from "bun:test";
import {
  buildUrls,
  notifyIndexNowForSource,
  submitToIndexNow,
  type IndexNowEnv,
  type IndexNowSource,
} from "../../workers/api/src/lib/indexnow.js";

const KEY_VALUE = "abc12345abc12345abc12345abc12345";
const KEY = {
  async get() {
    return KEY_VALUE;
  },
};

const SOURCE: IndexNowSource = {
  slug: "nextjs",
  orgSlug: "vercel",
  productSlug: null,
  isHidden: false,
  discovery: "curated",
};

function envOn(overrides: Partial<IndexNowEnv> = {}): IndexNowEnv {
  return {
    INDEXNOW_ENABLED: "true",
    INDEXNOW_KEY: KEY,
    WEB_BASE_URL: "https://releases.sh",
    ...overrides,
  };
}

describe("buildUrls", () => {
  it("emits org + source URLs by default", () => {
    expect(buildUrls("https://releases.sh", SOURCE)).toEqual([
      "https://releases.sh/vercel",
      "https://releases.sh/vercel/nextjs",
    ]);
  });

  it("includes the product page when productSlug is present", () => {
    expect(buildUrls("https://releases.sh", { ...SOURCE, productSlug: "next" })).toEqual([
      "https://releases.sh/vercel",
      "https://releases.sh/vercel/nextjs",
      "https://releases.sh/vercel/product/next",
    ]);
  });

  it("returns empty list when org slug is missing (independent source)", () => {
    expect(buildUrls("https://releases.sh", { ...SOURCE, orgSlug: null })).toEqual([]);
  });

  it("strips trailing slash from base URL", () => {
    expect(buildUrls("https://releases.sh/", SOURCE)[0]).toBe("https://releases.sh/vercel");
  });
});

describe("submitToIndexNow skip conditions", () => {
  it("skips when flag is off", async () => {
    const fetchImpl = stubFetch();
    const result = await submitToIndexNow(envOn({ INDEXNOW_ENABLED: "false" }), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: fetchImpl.fn,
    });
    expect(result).toEqual({ status: "skipped", reason: "flag_off" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("skips when INDEXING_DISABLED is true (staging)", async () => {
    const fetchImpl = stubFetch();
    const result = await submitToIndexNow(envOn({ INDEXING_DISABLED: "true" }), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: fetchImpl.fn,
    });
    expect(result.reason).toBe("indexing_disabled");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("skips when key binding is missing", async () => {
    const result = await submitToIndexNow(envOn({ INDEXNOW_KEY: undefined }), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: stubFetch().fn,
    });
    expect(result.reason).toBe("no_key_binding");
  });

  it("skips when no releases were inserted", async () => {
    const fetchImpl = stubFetch();
    const result = await submitToIndexNow(envOn(), {
      nReleases: 0,
      source: SOURCE,
      fetchImpl: fetchImpl.fn,
    });
    expect(result.reason).toBe("no_releases");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("skips when source is hidden", async () => {
    const result = await submitToIndexNow(envOn(), {
      nReleases: 1,
      source: { ...SOURCE, isHidden: true },
      fetchImpl: stubFetch().fn,
    });
    expect(result.reason).toBe("source_hidden");
  });

  it("skips on-demand sources", async () => {
    const result = await submitToIndexNow(envOn(), {
      nReleases: 1,
      source: { ...SOURCE, discovery: "on_demand" },
      fetchImpl: stubFetch().fn,
    });
    expect(result.reason).toBe("discovery_on_demand");
  });

  it("skips independent sources (no orgSlug → no URLs to ping)", async () => {
    const fetchImpl = stubFetch();
    const result = await submitToIndexNow(envOn(), {
      nReleases: 1,
      source: { ...SOURCE, orgSlug: null },
      fetchImpl: fetchImpl.fn,
    });
    expect(result.reason).toBe("no_urls");
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("submitToIndexNow happy path", () => {
  it("posts the right shape to api.indexnow.org", async () => {
    const fetchImpl = stubFetch({ status: 200 });
    const result = await submitToIndexNow(envOn(), {
      nReleases: 3,
      source: { ...SOURCE, productSlug: "next" },
      fetchImpl: fetchImpl.fn,
    });

    expect(result.status).toBe("submitted");
    expect(result.httpStatus).toBe(200);
    expect(fetchImpl.calls).toHaveLength(1);

    const call = fetchImpl.calls[0];
    expect(call.url).toBe("https://api.indexnow.org/IndexNow");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
    });
    const body = JSON.parse(call.init!.body as string);
    expect(body.host).toBe("releases.sh");
    expect(body.key).toBe(KEY_VALUE);
    expect(body.urlList).toEqual([
      "https://releases.sh/vercel",
      "https://releases.sh/vercel/nextjs",
      "https://releases.sh/vercel/product/next",
    ]);
  });

  it.each([
    [422, "4xx"],
    [503, "5xx"],
  ])("treats %i (%s) as error but does not throw", async (status) => {
    const fetchImpl = stubFetch({ status });
    const result = await submitToIndexNow(envOn(), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: fetchImpl.fn,
    });
    expect(result.status).toBe("error");
    expect(result.httpStatus).toBe(status);
  });

  it("swallows fetch rejections", async () => {
    const result = await submitToIndexNow(envOn(), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: (() =>
        Promise.reject(new Error("network unreachable"))) as unknown as typeof fetch,
    });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("network unreachable");
  });

  it("soft-fails when the secret binding rejects", async () => {
    const result = await submitToIndexNow(
      envOn({ INDEXNOW_KEY: { get: () => Promise.reject(new Error("secrets store down")) } }),
      { nReleases: 1, source: SOURCE, fetchImpl: stubFetch().fn },
    );
    expect(result.status).toBe("error");
    expect(result.reason).toContain("secrets store down");
  });

  it("soft-fails when WEB_BASE_URL is malformed", async () => {
    const result = await submitToIndexNow(envOn({ WEB_BASE_URL: "not-a-url" }), {
      nReleases: 1,
      source: SOURCE,
      fetchImpl: stubFetch().fn,
    });
    expect(result.status).toBe("error");
  });
});

describe("notifyIndexNowForSource gates", () => {
  let calls = 0;
  const counting = {
    async resolveOrgSlug(id: string) {
      calls++;
      return id;
    },
    async resolveProductSlug(id: string) {
      calls++;
      return id;
    },
  };

  type Source = Parameters<typeof notifyIndexNowForSource>[2];
  const SOURCE_ROW: Source = {
    slug: "nextjs",
    orgId: "org_vercel",
    productId: null,
    isHidden: false,
    discovery: "curated",
  };

  const cases: Array<[string, IndexNowEnv, Source, number, string]> = [
    ["INDEXNOW_ENABLED=false", envOn({ INDEXNOW_ENABLED: "false" }), SOURCE_ROW, 1, "flag_off"],
    [
      "INDEXING_DISABLED=true",
      envOn({ INDEXING_DISABLED: "true" }),
      SOURCE_ROW,
      1,
      "indexing_disabled",
    ],
    ["no key binding", envOn({ INDEXNOW_KEY: undefined }), SOURCE_ROW, 1, "no_key_binding"],
    ["zero releases", envOn(), SOURCE_ROW, 0, "no_releases"],
    ["hidden source", envOn(), { ...SOURCE_ROW, isHidden: true }, 1, "source_hidden"],
    [
      "on-demand source",
      envOn(),
      { ...SOURCE_ROW, discovery: "on_demand" },
      1,
      "discovery_on_demand",
    ],
    ["independent source", envOn(), { ...SOURCE_ROW, orgId: null }, 1, "no_urls"],
  ];

  for (const [label, env, source, n, reason] of cases) {
    it(`skips ${label} before any D1 lookup`, async () => {
      calls = 0;
      const result = await notifyIndexNowForSource(env, counting, source, n);
      expect(result.reason).toBe(reason);
      expect(calls).toBe(0);
    });
  }
});

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(response: { status?: number } = {}): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init,
    });
    return Promise.resolve(new Response(null, { status: response.status ?? 200 }));
  }) as unknown as typeof fetch;
  return { fn, calls };
}
