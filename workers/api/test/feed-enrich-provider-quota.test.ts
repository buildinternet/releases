/**
 * Provider-quota-exhaustion coverage for feed-enrich (issue #2168 item 5d).
 *
 * `enrichFeedItem`'s AI cleanup step (`extractArticleFn`) can throw a
 * provider quota/billing shutoff (an `AI_APICallError`-shaped error carrying
 * "reached your specified API usage limits" or similar — see
 * `classifyProviderQuota`). Before this fix that read as an ordinary
 * cheap-fetch/render failure and never surfaced the dedicated
 * `provider-quota-exhausted` event the way the Firecrawl ingest path does.
 *
 * Two things must hold:
 *  - the event fires, with the same field shape as the Firecrawl site
 *    (provider/regainAccessAt/providerMessage) plus a `lane` discriminator.
 *  - the lane stays fail-open: `enrichFeedItem` still returns
 *    `{ status: "no_improvement" }` rather than throwing.
 */
import { describe, it, expect, mock } from "bun:test";
import { enrichFeedItem, type EnrichDeps, type EnrichItem } from "../src/cron/feed-enrich.js";

const QUOTA_MESSAGE =
  "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.";

/** Mirrors how the AI SDK stamps provider identity on a real quota error
 *  (see `firecrawl-ingest-snapshot-durability.test.ts`'s attribution test). */
function quotaError(): Error {
  return Object.assign(new Error(QUOTA_MESSAGE), { providerId: "anthropic.messages" });
}

function makeDeps(overrides: Partial<EnrichDeps> = {}): {
  deps: EnrichDeps;
  events: Array<{ level: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const deps: EnrichDeps = {
    thinChars: 200,
    fetchImpl: (async () =>
      new Response("<html><body>thin</body></html>", { status: 200 })) as unknown as typeof fetch,
    extractArticleFn: async () => {
      throw quotaError();
    },
    renderFn: null,
    logEvent: ((level: "info" | "warn" | "error", payload: Record<string, unknown>) => {
      events.push({ level, payload });
    }) as EnrichDeps["logEvent"],
    ...overrides,
  };
  return { deps, events };
}

const ITEM: EnrichItem = {
  url: "https://example.com/blog/real-post",
  title: "A real post",
  summary: "short",
};

describe("feed-enrich — provider quota exhaustion (#2168 5d)", () => {
  it("emits provider-quota-exhausted when the cheap-path AI cleanup hits a quota shutoff", async () => {
    const { deps, events } = makeDeps();

    const result = await enrichFeedItem(ITEM, deps);

    // Fail-open: still degrades to no_improvement, never throws.
    expect(result).toEqual({ status: "no_improvement" });

    const quotaEvents = events.filter((e) => e.payload.event === "provider-quota-exhausted");
    expect(quotaEvents).toHaveLength(1);
    const [{ level, payload }] = quotaEvents;
    expect(level).toBe("error");
    expect(payload.component).toBe("feed-enrich");
    expect(payload.lane).toBe("feed-enrich");
    expect(payload.provider).toBe("anthropic");
    expect(payload.regainAccessAt).toBe("2026-08-01T00:00:00.000Z");
    expect(payload.providerMessage).toBe(QUOTA_MESSAGE);
    expect(payload.url).toBe(ITEM.url);

    // The existing cheap-fetch-failed log still fires alongside it — this is
    // additive observability, not a replacement.
    expect(events.some((e) => e.payload.event === "cheap-fetch-failed")).toBe(true);
  });

  it("emits provider-quota-exhausted on the render-escalation path too", async () => {
    const { deps, events } = makeDeps({
      // Cheap path fails for an unrelated (non-quota) reason so it escalates.
      fetchImpl: mock(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      renderFn: async () => "# rendered markdown",
      extractArticleFn: async () => {
        throw quotaError();
      },
    });

    const result = await enrichFeedItem(ITEM, deps);

    expect(result).toEqual({ status: "no_improvement" });
    const quotaEvents = events.filter((e) => e.payload.event === "provider-quota-exhausted");
    expect(quotaEvents).toHaveLength(1);
    expect(quotaEvents[0]?.payload.provider).toBe("anthropic");
  });

  it("does not emit provider-quota-exhausted for an ordinary (non-quota) failure", async () => {
    const { deps, events } = makeDeps({
      extractArticleFn: async () => {
        throw new Error("some transient parsing error");
      },
    });

    const result = await enrichFeedItem(ITEM, deps);

    expect(result).toEqual({ status: "no_improvement" });
    expect(events.some((e) => e.payload.event === "provider-quota-exhausted")).toBe(false);
  });
});
