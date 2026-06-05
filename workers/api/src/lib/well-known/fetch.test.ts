import { describe, it, expect } from "bun:test";
import { fetchReleasesJson } from "./fetch.js";

function resp(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("fetchReleasesJson", () => {
  it("returns parsed json on success", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp(JSON.stringify({ name: "Acme" })),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.json).toEqual({ name: "Acme" });
  });

  it("no-ops on 404", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("skips invalid json", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp("{not json"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_json");
  });

  it("skips bodies over the size cap", async () => {
    const big = JSON.stringify({ description: "x".repeat(70_000) });
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp(big),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  it("refuses non-https urls", async () => {
    const r = await fetchReleasesJson("http://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp("{}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });

  it("refuses private/loopback hosts", async () => {
    const r = await fetchReleasesJson("https://127.0.0.1/.well-known/releases.json", {
      fetchImpl: async () => resp("{}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });

  it("returns http_error for a 3xx (manual redirect, not followed)", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.com" } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("http_error");
  });

  it("returns http_error for a 5xx", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => new Response("boom", { status: 500 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("http_error");
  });
});
