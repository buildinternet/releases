import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_REVALIDATE_SECONDS } from "./isr.js";

/**
 * Regression guard for #source-page-500.
 *
 * The related-rail fetch is rendered on the statically generated source/product
 * pages. A `cache: "no-store"` fetch reached during static generation is
 * dynamic-server usage that aborts the prerender — Next then serves its built-in
 * 500 and Vercel caches it, which took every source-only page down sitewide.
 *
 * So the ISR call path MUST cache with a revalidate window (never `no-store`),
 * and the dynamic release-page path MUST keep `no-store` (its anchor keys span
 * tens of thousands of release IDs — a Data-Cache write per key is the cost the
 * `no-store` was chosen to avoid). Assert the RequestInit each mode produces.
 */

const ORIG_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

/** Swap fetch for a stub that records the init of the first call and returns `{}`. */
function captureInit(): { get: () => RequestInit | undefined } {
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { get: () => seen };
}

/** Next augments RequestInit with `next.revalidate`; read it without an `any`. */
function nextRevalidate(init: RequestInit | undefined): number | false | undefined {
  return (init as (RequestInit & { next?: { revalidate?: number | false } }) | undefined)?.next
    ?.revalidate;
}

describe("api.relatedReleases cache mode", () => {
  it('caches with the ISR revalidate window (never no-store) for cacheMode "isr"', async () => {
    const { api } = await import("./api.js");
    const cap = captureInit();
    await api.relatedReleases("rel_anchor", "org", 2, null, "isr");
    const init = cap.get();
    expect(init?.cache).not.toBe("no-store");
    expect(nextRevalidate(init)).toBe(DEFAULT_REVALIDATE_SECONDS);
  });

  it('keeps no-store for cacheMode "dynamic"', async () => {
    const { api } = await import("./api.js");
    const cap = captureInit();
    await api.relatedReleases("rel_anchor", "global", 2, null, "dynamic");
    const init = cap.get();
    expect(init?.cache).toBe("no-store");
    expect(nextRevalidate(init)).toBeUndefined();
  });

  it("defaults to dynamic (no-store) for direct callers", async () => {
    const { api } = await import("./api.js");
    const cap = captureInit();
    await api.relatedReleases("rel_anchor");
    expect(cap.get()?.cache).toBe("no-store");
  });
});
