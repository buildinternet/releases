import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { findOrg } from "../../src/api/orgs.js";
import { findProduct } from "../../src/api/products.js";
import { findSource } from "../../src/api/sources.js";
import { getRelease } from "../../src/api/releases.js";
import { apiFetch } from "../../src/api/core.js";
import { InvalidInputError, ApiError } from "../../src/lib/errors.js";

const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

// Resolvers reject hallucinated identifiers BEFORE any network call. We fail the
// test if fetch is ever reached for a bad identifier.
describe("entity resolvers reject unsafe identifiers without a network call", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalled = false;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const bad = "../../admin";

  it("findOrg rejects traversal", async () => {
    await expect(findOrg(bad)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchCalled).toBe(false);
  });

  it("findProduct rejects traversal", async () => {
    await expect(findProduct(bad)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchCalled).toBe(false);
  });

  it("findSource rejects traversal", async () => {
    await expect(findSource(bad)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchCalled).toBe(false);
  });

  it("getRelease rejects traversal (path is interpolated unencoded)", async () => {
    await expect(getRelease(bad)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchCalled).toBe(false);
  });

  it("getRelease rejects a percent-encoded id", async () => {
    await expect(getRelease("rel_%2e%2e")).rejects.toThrow(/percent-encoded/);
    expect(fetchCalled).toBe(false);
  });
});

describe("apiFetch error typing", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws a typed ApiError carrying status/method/path on a non-2xx mutation", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as any;

    let caught: unknown;
    try {
      await apiFetch("/v1/orgs/org_x", { method: "DELETE" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(403);
    expect(err.method).toBe("DELETE");
    expect(err.path).toBe("/v1/orgs/org_x");
    expect(err.serverMessage).toBe("Forbidden");
    // Message stays backward-compatible for existing string-match tests.
    expect(err.message).toMatch(/API error \(403\) on DELETE/);
  });
});
