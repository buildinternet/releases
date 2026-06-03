/**
 * Tests fetchWithRetry — the transient-failure retry wrapper added after a
 * one-off Anthropic 500 on skill-version creation failed a whole deploy.
 */
import { describe, it, expect } from "bun:test";
import { fetchWithRetry, RETRYABLE_STATUS } from "../../scripts/fetch-retry.js";

/** Build a fake fetch that yields the given statuses/errors in order (repeating the last). */
function seqFetch(items: Array<number | Error>) {
  const calls = { count: 0 };
  const fetchImpl = (async () => {
    const item = items[Math.min(calls.count, items.length - 1)];
    calls.count++;
    if (item instanceof Error) throw item;
    return new Response("body", { status: item });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// Fast + quiet: no real backoff, no retry logging.
const fast = { baseDelayMs: 0, sleepImpl: async () => {}, onRetry: () => {} };

describe("fetchWithRetry", () => {
  it("returns immediately on success (no retry)", async () => {
    const { fetchImpl, calls } = seqFetch([200]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl });
    expect(res.status).toBe(200);
    expect(calls.count).toBe(1);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { fetchImpl, calls } = seqFetch([400]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl });
    expect(res.status).toBe(400);
    expect(calls.count).toBe(1);
  });

  it("retries a 500 then succeeds", async () => {
    const { fetchImpl, calls } = seqFetch([500, 500, 200]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl, retries: 4 });
    expect(res.status).toBe(200);
    expect(calls.count).toBe(3);
  });

  it("retries a 429 then succeeds", async () => {
    const { fetchImpl, calls } = seqFetch([429, 200]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl, retries: 4 });
    expect(res.status).toBe(200);
    expect(calls.count).toBe(2);
  });

  it("retries a network error then succeeds", async () => {
    const { fetchImpl, calls } = seqFetch([new Error("ECONNRESET"), 200]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl, retries: 4 });
    expect(res.status).toBe(200);
    expect(calls.count).toBe(2);
  });

  it("returns the last failing Response after exhausting retries", async () => {
    const { fetchImpl, calls } = seqFetch([500, 500, 500]);
    const res = await fetchWithRetry("u", {}, { ...fast, fetchImpl, retries: 2 });
    expect(res.status).toBe(500);
    expect(calls.count).toBe(3); // initial + 2 retries
  });

  it("throws the last error when all attempts are network errors", async () => {
    const { fetchImpl, calls } = seqFetch([new Error("a"), new Error("b"), new Error("c")]);
    let threw = false;
    try {
      await fetchWithRetry("u", {}, { ...fast, fetchImpl, retries: 2 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls.count).toBe(3); // initial + 2 retries, then rethrow
  });

  it("treats 5xx + 429 as retryable", () => {
    for (const s of [429, 500, 502, 503, 504, 529]) expect(RETRYABLE_STATUS.has(s)).toBe(true);
    for (const s of [200, 400, 401, 404]) expect(RETRYABLE_STATUS.has(s)).toBe(false);
  });
});
