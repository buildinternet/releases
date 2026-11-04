import { describe, expect, it } from "bun:test";
import {
  BlockedOutboundUrlError,
  guardFetch,
  isBlockedOutboundHost,
} from "./outbound-fetch-guard.js";

function recorder(responses: Record<string, () => Response>) {
  const calls: Array<{ url: string; redirect?: string; method?: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, redirect: init?.redirect, method: init?.method });
    const make = responses[url];
    return make ? make() : new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("isBlockedOutboundHost", () => {
  it("blocks internal names and private literals", () => {
    for (const h of [
      "localhost",
      "api.localhost",
      "printer.local",
      "svc.internal",
      "intranet",
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "[::1]",
      "[::ffff:7f00:1]",
      "999.1.1.1",
      "",
    ]) {
      expect(isBlockedOutboundHost(h)).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "[2606:4700:4700::1111]", "docs.anthropic.com"]) {
      expect(isBlockedOutboundHost(h)).toBe(false);
    }
  });
});

describe("guardFetch", () => {
  it("refuses a private target without calling fetch", async () => {
    const { impl, calls } = recorder({});
    const f = guardFetch(impl);
    await expect(f("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      BlockedOutboundUrlError,
    );
    await expect(f("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedOutboundUrlError);
    expect(calls).toHaveLength(0);
  });

  it("follows public redirects hop by hop with redirect: manual", async () => {
    const { impl, calls } = recorder({
      "https://a.example/feed": () =>
        new Response(null, { status: 301, headers: { location: "/feed.xml" } }),
      "https://a.example/feed.xml": () =>
        new Response(null, { status: 302, headers: { location: "https://cdn.example/feed.xml" } }),
    });
    const res = await guardFetch(impl)("https://a.example/feed", { redirect: "follow" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example/feed",
      "https://a.example/feed.xml",
      "https://cdn.example/feed.xml",
    ]);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("refuses a redirect to a private host", async () => {
    const { impl, calls } = recorder({
      "https://a.example/feed": () =>
        new Response(null, { status: 307, headers: { location: "http://10.0.0.5/admin" } }),
    });
    await expect(guardFetch(impl)("https://a.example/feed")).rejects.toBeInstanceOf(
      BlockedOutboundUrlError,
    );
    expect(calls).toHaveLength(1);
  });

  it("caps the redirect chain", async () => {
    const { impl } = recorder({
      "https://a.example/loop": () =>
        new Response(null, { status: 302, headers: { location: "/loop" } }),
    });
    await expect(guardFetch(impl, { maxRedirects: 3 })("https://a.example/loop")).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("passes redirect: manual through untouched", async () => {
    const { impl, calls } = recorder({
      "https://a.example/x": () =>
        new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    });
    const res = await guardFetch(impl)("https://a.example/x", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("keeps HEAD on a redirected probe", async () => {
    const { impl, calls } = recorder({
      "https://a.example/rss": () =>
        new Response(null, { status: 303, headers: { location: "/rss.xml" } }),
    });
    await guardFetch(impl)("https://a.example/rss", { method: "HEAD" });
    expect(calls[1]).toMatchObject({ url: "https://a.example/rss.xml", method: "HEAD" });
  });
});
