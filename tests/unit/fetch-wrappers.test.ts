import { describe, it, expect } from "bun:test";
import {
  STAGING_KEY_HEADER,
  withStagingHeader,
  withDiscoveryIdentity,
  directApiFetcher,
} from "../../workers/discovery/src/fetch-wrappers";
import {
  DISCOVERY_USER_AGENT,
  DISCOVERY_REQUESTED_WITH,
} from "../../workers/discovery/src/identity";
import { restoreGlobalFetch } from "../global-fetch";

/**
 * Regression tests for #550. The wrappers must NOT forward the original `init`
 * to the inner fetcher — in Cloudflare's `fetch(req, init)` semantics,
 * `init.headers` replaces `req.headers`, silently dropping any header the
 * wrapper just set.
 */

type TestFetcher = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

function captureFetcher(): {
  calls: { input: Request; init?: RequestInit }[];
  fetcher: TestFetcher;
} {
  const calls: { input: Request; init?: RequestInit }[] = [];
  const fetcher: TestFetcher = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(input instanceof Request)) {
        throw new Error("expected Request input");
      }
      calls.push({ input, init });
      return Promise.resolve(new Response("ok"));
    },
  };
  return { calls, fetcher };
}

describe("withStagingHeader", () => {
  it("returns the same fetcher unchanged when key is empty (prod/local)", () => {
    const { fetcher } = captureFetcher();
    expect(withStagingHeader(fetcher, "")).toBe(fetcher);
  });

  it("sets the staging key header on string inputs", async () => {
    const { calls, fetcher } = captureFetcher();
    const wrapped = withStagingHeader(fetcher, "secret-key");

    await wrapped.fetch("https://api/v1/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: '{"ok":true}',
    });

    expect(calls).toHaveLength(1);
    const req = calls[0]!.input;
    expect(req.headers.get(STAGING_KEY_HEADER)).toBe("secret-key");
    // Init from the caller is baked into the Request — preserved.
    expect(req.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer x");
    expect(req.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves the staging key when input is already a Request", async () => {
    const { calls, fetcher } = captureFetcher();
    const wrapped = withStagingHeader(fetcher, "secret-key");

    const incoming = new Request("https://api/v1/sources", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
    });
    await wrapped.fetch(incoming);

    expect(calls[0]!.input.headers.get(STAGING_KEY_HEADER)).toBe("secret-key");
    expect(calls[0]!.input.headers.get("Authorization")).toBe("Bearer x");
  });

  it("does not forward the original init — init.headers would override req.headers", async () => {
    const { calls, fetcher } = captureFetcher();
    const wrapped = withStagingHeader(fetcher, "secret-key");

    await wrapped.fetch("https://api/v1/sources", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
    });

    // If the wrapper forwarded init, Cloudflare would replace req.headers with
    // init.headers on the next hop, dropping the staging key. Guard against
    // that regression by asserting the inner fetcher receives no init.
    expect(calls[0]!.init).toBeUndefined();
  });
});

describe("withDiscoveryIdentity", () => {
  it("sets User-Agent and X-Requested-With on outbound requests", async () => {
    const { calls, fetcher } = captureFetcher();
    const wrapped = withDiscoveryIdentity(fetcher);

    await wrapped.fetch("https://api/v1/sources", { method: "GET" });

    expect(calls[0]!.input.headers.get("User-Agent")).toBe(DISCOVERY_USER_AGENT);
    expect(calls[0]!.input.headers.get("X-Requested-With")).toBe(DISCOVERY_REQUESTED_WITH);
    expect(calls[0]!.init).toBeUndefined();
  });

  it("stacks with withStagingHeader — both headers survive", async () => {
    const { calls, fetcher } = captureFetcher();
    const wrapped = withDiscoveryIdentity(withStagingHeader(fetcher, "secret"));

    await wrapped.fetch("https://api/v1/sources", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: "{}",
    });

    const req = calls[0]!.input;
    expect(req.headers.get(STAGING_KEY_HEADER)).toBe("secret");
    expect(req.headers.get("User-Agent")).toBe(DISCOVERY_USER_AGENT);
    expect(req.headers.get("X-Requested-With")).toBe(DISCOVERY_REQUESTED_WITH);
    expect(req.headers.get("Authorization")).toBe("Bearer x");
    expect(req.method).toBe("POST");
  });
});

describe("directApiFetcher", () => {
  it("rewrites placeholder URLs for string inputs", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      seen.push(typeof input === "string" ? input : input.url);
      return new Response("ok");
    }) as typeof fetch;

    try {
      const f = directApiFetcher("https://api-staging.releases.sh/");
      await f.fetch("https://api/v1/sources");
      expect(seen[0]).toBe("https://api-staging.releases.sh/v1/sources");
    } finally {
      restoreGlobalFetch();
    }
  });

  it("rewrites placeholder URLs for Request inputs (so wrapper-upgraded requests still resolve)", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return new Response("ok");
    }) as typeof fetch;

    try {
      const f = directApiFetcher("https://api-staging.releases.sh");
      const req = new Request("https://api/v1/sources", {
        method: "POST",
        headers: { "X-Custom": "yes" },
      });
      await f.fetch(req);
      expect(seen[0]).toBe("https://api-staging.releases.sh/v1/sources");
    } finally {
      restoreGlobalFetch();
    }
  });
});
