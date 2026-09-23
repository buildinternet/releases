import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchWithRetry } from "./fetch-with-retry";

const NO_DELAY = { backoffMs: [0, 0] };
const originalFetch = globalThis.fetch;

describe("fetchWithRetry", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("succeeds after a transient failure", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.com/skill.md", NO_DELAY);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("gives up after 3 attempts on persistent failure", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      throw new Error("ECONNRESET");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchWithRetry("https://example.com/skill.md", NO_DELAY)).rejects.toThrow(
      "ECONNRESET",
    );
    expect(calls).toBe(3);
  });

  test("does not retry a 404", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.com/skill.md", NO_DELAY);
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  test("retries a 5xx response and then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) return new Response("boom", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.com/skill.md", NO_DELAY);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("retries a 429 response", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.com/skill.md", NO_DELAY);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
