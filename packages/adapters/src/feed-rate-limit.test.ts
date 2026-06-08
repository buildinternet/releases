import { describe, it, expect } from "bun:test";
import { fetchAndParseFeed, parseRetryAfterMs } from "./feed";
import { FeedHttpError, isTransientFeedHttpStatus } from "@releases/lib/errors";

function fetchStatus(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response("", { status, headers })) as unknown as typeof fetch;
}

/** Await a promise expected to reject with a FeedHttpError; returns it typed. */
async function expectFeedHttpError(p: Promise<unknown>): Promise<FeedHttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FeedHttpError) return e;
    throw e;
  }
  throw new Error("expected fetchAndParseFeed to throw FeedHttpError");
}

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP-date as a non-negative offset from now", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(60_000);
  });

  it("clamps a past HTTP-date to 0 rather than going negative", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it("returns undefined for absent / blank / unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("isTransientFeedHttpStatus", () => {
  it("flags 429 and 408 as transient", () => {
    expect(isTransientFeedHttpStatus(429)).toBe(true);
    expect(isTransientFeedHttpStatus(408)).toBe(true);
  });

  it("treats other 4xx as gone, not transient", () => {
    for (const s of [400, 403, 404, 410]) expect(isTransientFeedHttpStatus(s)).toBe(false);
  });
});

describe("fetchAndParseFeed 429 handling", () => {
  it("throws FeedHttpError carrying the Retry-After hint on 429", async () => {
    const err = await expectFeedHttpError(
      fetchAndParseFeed(
        "https://ex.com/feed.xml",
        "rss",
        undefined,
        undefined,
        fetchStatus(429, { "retry-after": "300" }),
      ),
    );
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(300_000);
    expect(isTransientFeedHttpStatus(err.status)).toBe(true);
  });

  it("throws FeedHttpError with undefined retryAfterMs when the header is absent", async () => {
    const err = await expectFeedHttpError(
      fetchAndParseFeed("https://ex.com/feed.xml", "rss", undefined, undefined, fetchStatus(429)),
    );
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("still throws a gone-style FeedHttpError on 404 (not transient)", async () => {
    const err = await expectFeedHttpError(
      fetchAndParseFeed("https://ex.com/feed.xml", "rss", undefined, undefined, fetchStatus(404)),
    );
    expect(err.status).toBe(404);
    expect(isTransientFeedHttpStatus(err.status)).toBe(false);
  });
});
