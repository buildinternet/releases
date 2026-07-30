import { describe, it, expect } from "bun:test";
import {
  notifyWebRevalidate,
  type WebRevalidateEnv,
  type RevalidateableSource,
} from "../../workers/api/src/lib/web-revalidate.js";

const SECRET_VALUE = "shared-revalidate-secret";
const SECRET = {
  async get() {
    return SECRET_VALUE;
  },
};

const SOURCE: RevalidateableSource = {
  slug: "nextjs",
  orgId: "org_1",
  productId: null,
  isHidden: false,
};

const DB = {
  async resolveOrgSlug(id: string) {
    return id === "org_1" ? "vercel" : null;
  },
  async resolveProductSlug(id: string) {
    return id === "prod_1" ? "next" : null;
  },
};

function envOn(overrides: Partial<WebRevalidateEnv> = {}): WebRevalidateEnv {
  return {
    WEB_SERVICE_KEY: SECRET,
    WEB_BASE_URL: "https://releases.sh",
    ...overrides,
  };
}

interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** Records the outbound ping and replies with `status`. */
function recorder(status = 200): { calls: Recorded[]; fetchImpl: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ revalidated: [] }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("notifyWebRevalidate", () => {
  it("posts the affected slugs to the web revalidate endpoint", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(envOn(), DB, SOURCE, 3, { fetchImpl });

    expect(res.status).toBe("revalidated");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://releases.sh/api/revalidate");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.authorization).toBe(`Bearer ${SECRET_VALUE}`);
    expect(calls[0]!.body).toEqual({ orgSlug: "vercel", sourceSlug: "nextjs" });
  });

  it("includes the product slug when the source has a product", async () => {
    const { calls, fetchImpl } = recorder();
    await notifyWebRevalidate(envOn(), DB, { ...SOURCE, productId: "prod_1" }, 1, { fetchImpl });

    expect(calls[0]!.body).toEqual({
      orgSlug: "vercel",
      sourceSlug: "nextjs",
      productSlug: "next",
    });
  });

  it("skips when no secret binding is configured", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(envOn({ WEB_SERVICE_KEY: undefined }), DB, SOURCE, 1, {
      fetchImpl,
    });

    expect(res).toEqual({ status: "skipped", reason: "no_secret_binding" });
    expect(calls).toEqual([]);
  });

  it("skips when the secret binding resolves empty", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(
      envOn({
        WEB_SERVICE_KEY: {
          async get() {
            return undefined;
          },
        },
      }),
      DB,
      SOURCE,
      1,
      { fetchImpl },
    );

    expect(res).toEqual({ status: "skipped", reason: "secret_unset" });
    expect(calls).toEqual([]);
  });

  it("skips when nothing was inserted", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(envOn(), DB, SOURCE, 0, { fetchImpl });

    expect(res).toEqual({ status: "skipped", reason: "no_releases" });
    expect(calls).toEqual([]);
  });

  it("skips a hidden source, whose pages are filtered from public reads", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(envOn(), DB, { ...SOURCE, isHidden: true }, 1, {
      fetchImpl,
    });

    expect(res).toEqual({ status: "skipped", reason: "source_hidden" });
    expect(calls).toEqual([]);
  });

  it("skips an org-less source, which has no org page to revalidate", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(envOn(), DB, { ...SOURCE, orgId: null }, 1, {
      fetchImpl,
    });

    expect(res).toEqual({ status: "skipped", reason: "no_org" });
    expect(calls).toEqual([]);
  });

  it("reports a non-2xx response as an error without throwing", async () => {
    const { fetchImpl } = recorder(401);
    const res = await notifyWebRevalidate(envOn(), DB, SOURCE, 1, { fetchImpl });

    expect(res.status).toBe("error");
    expect(res.httpStatus).toBe(401);
  });

  // The pre-flight awaits (secret read, slug lookups) are as failure-prone as the
  // ping itself. Left outside the try they escape as a rejected promise, which
  // `Promise.allSettled` in runBatchIngestEffects swallows — no log line, no
  // result, and the page silently stays stale until the backstop.
  it("swallows a rejected secret binding and reports it as an error", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await notifyWebRevalidate(
      envOn({
        WEB_SERVICE_KEY: {
          async get() {
            throw new Error("secrets store unavailable");
          },
        },
      }),
      DB,
      SOURCE,
      1,
      { fetchImpl },
    );

    expect(res.status).toBe("error");
    expect(res.reason).toContain("secrets store unavailable");
    expect(calls).toEqual([]);
  });

  it("swallows a rejected org-slug lookup and reports it as an error", async () => {
    const { calls, fetchImpl } = recorder();
    const failingDb = {
      async resolveOrgSlug() {
        throw new Error("D1_ERROR: network");
      },
      resolveProductSlug: DB.resolveProductSlug,
    };
    const res = await notifyWebRevalidate(envOn(), failingDb, SOURCE, 1, { fetchImpl });

    expect(res.status).toBe("error");
    expect(res.reason).toContain("D1_ERROR");
    expect(calls).toEqual([]);
  });

  it("swallows a rejected product-slug lookup and reports it as an error", async () => {
    const { calls, fetchImpl } = recorder();
    const failingDb = {
      resolveOrgSlug: DB.resolveOrgSlug,
      async resolveProductSlug() {
        throw new Error("D1_ERROR: network");
      },
    };
    const res = await notifyWebRevalidate(
      envOn(),
      failingDb,
      { ...SOURCE, productId: "prod_1" },
      1,
      { fetchImpl },
    );

    expect(res.status).toBe("error");
    expect(calls).toEqual([]);
  });

  // A dropped ping must never fail the ingest that triggered it — the page just
  // stays stale until the 24h backstop in web's `lib/isr.ts`.
  it("swallows a network failure and reports it as an error", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await notifyWebRevalidate(envOn(), DB, SOURCE, 1, { fetchImpl });

    expect(res.status).toBe("error");
    expect(res.reason).toContain("ECONNREFUSED");
  });
});
