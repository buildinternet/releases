/**
 * Tests for the upstream-status probe in `scrape-fetch.ts`.
 *
 * Motivation: Cloudflare Browser Rendering happily renders a 404 page and
 * returns the resulting HTML as a "successful" markdown payload. The AI
 * extractor then turns that into a release row titled "Page not found".
 * `probeUpstreamStatus` hits the origin directly so the scrape path can
 * short-circuit before the rendered error page reaches the extractor.
 *
 * The probe is HEAD-first with a GET fallback on 405 / 501 (some origins
 * reject HEAD outright). Network errors and timeouts return null so the
 * caller falls through to the existing CF rendering path rather than
 * suppressing a fetch on transient probe failure.
 */

import { describe, it, expect } from "bun:test";
import { probeUpstreamStatus, isUpstreamGone } from "../../workers/discovery/src/scrape-fetch";

/** Build a minimal Response-like stub that mimics what `fetch` returns. */
function stubResponse(status: number, opts: { hasBody?: boolean } = {}): Response {
  const body = opts.hasBody ? "ok" : null;
  return new Response(body, { status });
}

describe("probeUpstreamStatus", () => {
  it("returns the HEAD status directly when the origin honors HEAD", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return stubResponse(404);
    }) as unknown as typeof fetch;

    const result = await probeUpstreamStatus("https://example.com/missing", fakeFetch);

    expect(result).toEqual({ status: 404 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("HEAD");
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      // Origin rejects HEAD but the page is alive.
      return stubResponse(init?.method === "HEAD" ? 405 : 200, { hasBody: true });
    }) as unknown as typeof fetch;

    const result = await probeUpstreamStatus("https://example.com/page", fakeFetch);

    expect(result).toEqual({ status: 200 });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("HEAD");
    expect(calls[1].method).toBe("GET");
  });

  it("falls back to GET when HEAD returns 501 Not Implemented", async () => {
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return stubResponse(init?.method === "HEAD" ? 501 : 410);
    }) as unknown as typeof fetch;

    const result = await probeUpstreamStatus("https://example.com/gone", fakeFetch);

    // Originally rejected HEAD with 501, then surfaced 410 on GET.
    expect(result).toEqual({ status: 410 });
  });

  it("returns null on network errors / aborts so the caller doesn't suppress on transient failure", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch;

    const result = await probeUpstreamStatus("https://example.com/", fakeFetch);

    expect(result).toBeNull();
  });

  it("does NOT fall through to GET on non-HEAD-rejection statuses", async () => {
    // 403 likely means our bot UA is blocked at the perimeter — CF Browser
    // Rendering might still succeed there, so we should NOT short-circuit
    // *and* should not double-probe with GET (no real signal).
    const calls: Array<{ method?: string }> = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method });
      return stubResponse(403);
    }) as unknown as typeof fetch;

    const result = await probeUpstreamStatus("https://example.com/", fakeFetch);

    expect(result).toEqual({ status: 403 });
    expect(calls).toHaveLength(1); // No retry; the caller decides what to do.
  });
});

describe("isUpstreamGone", () => {
  it("returns true for definitively-gone statuses", () => {
    expect(isUpstreamGone(404)).toBe(true);
    expect(isUpstreamGone(410)).toBe(true);
  });

  it("returns false for blocked / transient / successful statuses", () => {
    // 401 / 403: bot UA detection may block our probe but CF can still render.
    expect(isUpstreamGone(401)).toBe(false);
    expect(isUpstreamGone(403)).toBe(false);
    // 5xx: transient — let the existing error-tier backoff handle retries.
    expect(isUpstreamGone(500)).toBe(false);
    expect(isUpstreamGone(503)).toBe(false);
    // 200/301: success / redirect — let CF rendering proceed.
    expect(isUpstreamGone(200)).toBe(false);
    expect(isUpstreamGone(301)).toBe(false);
  });
});
