/**
 * Fetcher wrappers for the managed-agents Durable Object.
 *
 * Extracted into a pure module so they can be unit-tested without pulling in
 * `cloudflare:workers`. The wrappers compose: each returns a Fetcher that
 * mutates outbound headers before delegating to the inner fetcher.
 *
 * IMPORTANT: wrappers pass only the modified `Request` to the inner fetcher,
 * never the original `init`. In Cloudflare's fetch semantics, `fetch(req, init)`
 * lets `init.headers` override `req.headers`, so forwarding `init` silently
 * drops every header the wrapper just set (see #550).
 */

import { discoveryIdentityHeaders } from "./identity.js";

/**
 * Minimal Fetcher interface covering the one method we use. Declared locally
 * instead of leaning on Cloudflare's ambient `Fetcher` so this module (and its
 * tests) can compile outside the Workers runtime typing context.
 */
export type Fetcher = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/** Staging access gate header — must match workers/api/src/middleware/staging-access.ts. */
export const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Wrap a Fetcher so every outbound request carries the staging access key.
 * Returns the fetcher unchanged when `stagingKey` is empty (prod/local).
 */
export function withStagingHeader(fetcher: Fetcher, stagingKey: string): Fetcher {
  if (!stagingKey) return fetcher;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      req.headers.set(STAGING_KEY_HEADER, stagingKey);
      return fetcher.fetch(req);
    },
  } as Fetcher;
}

/**
 * Wrap a Fetcher so every outbound request carries the discovery worker's
 * identity headers (User-Agent, X-Requested-With). These surface in Cloudflare
 * Analytics on the API edge so staging traffic is distinguishable from real
 * visitors. Harmless on service-binding fetches.
 */
export function withDiscoveryIdentity(fetcher: Fetcher): Fetcher {
  const identity = discoveryIdentityHeaders();
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      for (const [k, v] of Object.entries(identity)) req.headers.set(k, v);
      return fetcher.fetch(req);
    },
  } as Fetcher;
}

/**
 * Build the fallback direct-fetch fetcher used when no service binding to the
 * API worker is present (local dev / tests). Rewrites the placeholder host
 * `https://api/...` to the real API base URL for all three input shapes
 * (string, URL, Request), so it works even after a wrapper has upgraded the
 * input to a Request.
 */
export function directApiFetcher(apiBaseUrl: string): Fetcher {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string") {
        return globalThis.fetch(input.replace("https://api", base), init);
      }
      if (input instanceof URL) {
        return globalThis.fetch(input.toString().replace("https://api", base), init);
      }
      const rewritten = input.url.replace("https://api", base);
      return globalThis.fetch(new Request(rewritten, input), init);
    },
  } as Fetcher;
}
