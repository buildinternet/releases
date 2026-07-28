import { describe, it, expect } from "bun:test";
import { classifyProviderQuota } from "./provider-quota.js";

describe("classifyProviderQuota", () => {
  it("detects the Anthropic spend-cap shutoff that caused the 2026-07-23 outage", () => {
    // Verbatim from the AI_APICallError logged by feed-enrich / firecrawl-ingest.
    const err = new Error(
      "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
    );
    const q = classifyProviderQuota(err);
    expect(q).not.toBeNull();
    expect(q?.regainAccessAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("parses a regain date with no explicit time", () => {
    const q = classifyProviderQuota(
      new Error(
        "You have reached your specified API usage limits. You will regain access on 2026-09-01.",
      ),
    );
    expect(q?.regainAccessAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns null regainAccessAt when the provider states no date", () => {
    const q = classifyProviderQuota(new Error("Your credit balance is too low."));
    expect(q).not.toBeNull();
    expect(q?.regainAccessAt).toBeNull();
  });

  it("attributes the provider from the AI SDK's providerId", () => {
    const err = Object.assign(new Error("Insufficient credits"), {
      providerId: "openrouter.chat",
    });
    expect(classifyProviderQuota(err)?.provider).toBe("openrouter");
  });

  // The distinction this module exists to make: a 429 is retryable, a quota
  // shutoff is not. Confusing them is what made the outage invisible.
  it("does NOT match ordinary rate limiting", () => {
    expect(classifyProviderQuota(new Error("429 Too Many Requests"))).toBeNull();
    expect(classifyProviderQuota(new Error("rate_limit_error: slow down"))).toBeNull();
  });

  it("ignores unrelated failures and non-errors", () => {
    expect(classifyProviderQuota(new Error("socket hang up"))).toBeNull();
    expect(classifyProviderQuota(null)).toBeNull();
    expect(classifyProviderQuota(undefined)).toBeNull();
    expect(classifyProviderQuota("")).toBeNull();
  });

  // A retryable window limit misread as a hard stop is now actively harmful:
  // callers refuse to retry quota errors, so this would turn a 30-second blip
  // into a failed ingest.
  it("does NOT match retryable window limits that mention quota", () => {
    expect(
      classifyProviderQuota(new Error("Quota exceeded for this minute; retry after 30 seconds")),
    ).toBeNull();
    expect(classifyProviderQuota(new Error("quota exceeded: 10 requests per minute"))).toBeNull();
    expect(classifyProviderQuota(new Error("Quota exceeded. Retry-After: 60"))).toBeNull();
  });

  it("still matches quota wording that is scoped to billing or the plan", () => {
    expect(
      classifyProviderQuota(new Error("Quota exceeded for your billing period")),
    ).not.toBeNull();
    expect(classifyProviderQuota(new Error("Monthly quota exceeded on your plan"))).not.toBeNull();
  });

  // `new Date("2026-02-31")` silently rolls over to March 3 rather than being
  // invalid, so an overflowed reset date would reach an operator as a confident
  // wrong one.
  it("rejects an overflowed calendar reset date instead of rolling it over", () => {
    const q = classifyProviderQuota(
      new Error(
        "You have reached your specified API usage limits. You will regain access on 2026-02-31.",
      ),
    );
    expect(q).not.toBeNull();
    expect(q?.regainAccessAt).toBeNull();
  });

  it("accepts a bare string message", () => {
    expect(
      classifyProviderQuota("You have reached your specified API usage limits."),
    ).not.toBeNull();
  });
});
