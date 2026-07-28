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

  it("accepts a bare string message", () => {
    expect(
      classifyProviderQuota("You have reached your specified API usage limits."),
    ).not.toBeNull();
  });
});
