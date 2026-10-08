import { describe, it, expect, afterEach } from "bun:test";
import {
  robotsUrlFor,
  looksLikeHtml,
  parseRobotsTxt,
  contentSignalPreflight,
} from "../../src/lib/content-signal.js";

// ── Pure parsing ─────────────────────────────────────────────────────────────

describe("robotsUrlFor", () => {
  it("maps a bare domain to its origin robots.txt over https", () => {
    expect(robotsUrlFor("conductor.build")).toBe("https://conductor.build/robots.txt");
  });

  it("collapses a deep URL to the origin", () => {
    expect(robotsUrlFor("https://example.com/blog/changelog?page=2")).toBe(
      "https://example.com/robots.txt",
    );
  });

  it("preserves an explicit http scheme and port", () => {
    expect(robotsUrlFor("http://localhost:8787/x")).toBe("http://localhost:8787/robots.txt");
  });
});

describe("looksLikeHtml", () => {
  it("detects a doctype / html / head challenge wall", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html>…")).toBe(true);
    expect(looksLikeHtml("\n  <html lang=en>")).toBe(true);
    expect(looksLikeHtml("<head><title>Just a moment…</title></head>")).toBe(true);
  });

  it("treats a plain robots policy as not-HTML", () => {
    expect(looksLikeHtml("User-agent: *\nDisallow:\n")).toBe(false);
  });
});

describe("parseRobotsTxt", () => {
  it("flags ai-input=no / ai-train=no from a single Content-Signal line (conductor.build)", () => {
    const body = [
      "User-agent: *",
      "Content-Signal: ai-train=no, search=yes, ai-input=no",
      "Disallow:",
      "Sitemap: https://conductor.build/sitemap.xml",
    ].join("\n");
    const { contentSignal, sitemaps, blocked } = parseRobotsTxt(body);
    expect(blocked.toSorted()).toEqual(["ai-input=no", "ai-train=no"]);
    expect(contentSignal).toMatchObject({ "ai-train": "no", search: "yes", "ai-input": "no" });
    expect(sitemaps).toEqual(["https://conductor.build/sitemap.xml"]);
  });

  it("takes the strictest reading — an earlier =no is never overwritten by a later =yes", () => {
    const body = [
      "Content-Signal: ai-input=no",
      "User-agent: GoodBot",
      "Content-Signal: ai-input=yes, ai-train=yes",
    ].join("\n");
    const { blocked, contentSignal } = parseRobotsTxt(body);
    expect(contentSignal?.["ai-input"]).toBe("no");
    expect(blocked).toContain("ai-input=no");
  });

  it("returns no block and null signal for a permissive / signal-free file", () => {
    const { contentSignal, blocked } = parseRobotsTxt("User-agent: *\nDisallow: /private\n");
    expect(contentSignal).toBeNull();
    expect(blocked).toEqual([]);
  });

  it("treats a permissive Content-Signal as proceed-worthy (signal present, nothing blocked)", () => {
    const { contentSignal, blocked } = parseRobotsTxt("Content-Signal: ai-input=yes, search=yes");
    expect(contentSignal).toMatchObject({ "ai-input": "yes", search: "yes" });
    expect(blocked).toEqual([]);
  });

  it("ignores comments and collects multiple sitemaps", () => {
    const body = [
      "# a comment",
      "Sitemap: https://a.example/sitemap.xml",
      "Sitemap: https://a.example/news-sitemap.xml # inline note",
    ].join("\n");
    const { sitemaps } = parseRobotsTxt(body);
    expect(sitemaps).toEqual([
      "https://a.example/sitemap.xml",
      "https://a.example/news-sitemap.xml",
    ]);
  });
});

// ── Fetch + verdict (mocked global fetch) ────────────────────────────────────

describe("contentSignalPreflight", () => {
  let originalFetch: typeof globalThis.fetch;
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  function mockRobots(body: string, init?: { status?: number }) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: init?.status ?? 200,
        headers: { "Content-Type": "text/plain" },
      })) as unknown as typeof globalThis.fetch;
  }

  it("REFUSES conductor.build (ai-input=no, ai-train=no) — the negative regression target", async () => {
    mockRobots("Content-Signal: ai-train=no, search=yes, ai-input=no\n");
    const r = await contentSignalPreflight("conductor.build");
    expect(r.verdict).toBe("refuse");
    expect(r.blocked.toSorted()).toEqual(["ai-input=no", "ai-train=no"]);
    expect(r.robotsUrl).toBe("https://conductor.build/robots.txt");
  });

  it("PROCEEDS on a permissive file and surfaces the sitemap", async () => {
    mockRobots("User-agent: *\nDisallow:\nSitemap: https://ex.com/sitemap.xml\n");
    const r = await contentSignalPreflight("https://ex.com/changelog");
    expect(r.verdict).toBe("proceed");
    expect(r.sitemaps).toEqual(["https://ex.com/sitemap.xml"]);
  });

  it("PROCEEDS when robots.txt is absent (404) — no opt-out declared", async () => {
    mockRobots("", { status: 404 });
    const r = await contentSignalPreflight("ex.com");
    expect(r.verdict).toBe("proceed");
    expect(r.robotsStatus).toBe(404);
  });

  it("returns UNKNOWN on a non-404 error status (fail closed, do not assume proceed)", async () => {
    mockRobots("", { status: 503 });
    const r = await contentSignalPreflight("ex.com");
    expect(r.verdict).toBe("unknown");
  });

  it("returns UNKNOWN when robots.txt is an HTML challenge wall", async () => {
    mockRobots("<!DOCTYPE html><html><head><title>Just a moment…</title></head></html>");
    const r = await contentSignalPreflight("ex.com");
    expect(r.verdict).toBe("unknown");
  });

  it("returns UNKNOWN on a network error rather than throwing", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const r = await contentSignalPreflight("ex.com");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });
});
