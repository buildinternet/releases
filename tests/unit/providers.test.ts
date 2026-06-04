import { describe, it, expect } from "bun:test";
import {
  detectProviderFromHtml,
  detectFromUrl,
  getProviderHints,
} from "@releases/ai-internal/providers";

// Detection markers were verified against real Fern-hosted changelogs in June 2026:
// - elevenlabs.io/docs/changelog and docs.cohere.com/changelog carry `buildwithfern`
//   70+ times in <head>; their docs run on the customer domain via Vercel (CNAME
//   cname.vercel-dns.com), so the `buildwithfern.com` CNAME never matches them.
// - The `fve-data-id` / `fve-mdx-b64` Fern Visual Editor attributes only appear in
//   page *body* content, never in <head>, so they cannot drive detectFromHttpSignals
//   (which scans headHtml only). `buildwithfern` is the load-bearing signal.

describe("Fern provider detection", () => {
  it("detects Fern from the `buildwithfern` <head> marker", () => {
    const head = `<head><link rel="preconnect" href="https://app-cdn.buildwithfern.com"><script src="https://app-cdn.buildwithfern.com/_next/static/chunk.js"></script></head>`;
    const provider = detectProviderFromHtml(head);
    expect(provider?.id).toBe("fern");
  });

  it("detects Fern from a `fern-docs` class marker", () => {
    const head = `<head><div class="fern-docs-bg"></div></head>`;
    expect(detectProviderFromHtml(head)?.id).toBe("fern");
  });

  it("does not rely on the body-only fve-* attributes (a realistic head has none)", () => {
    // Real customer heads contain `buildwithfern` but no fve-* attributes; detection
    // must still succeed. This locks in that fve-* is not the load-bearing signal.
    const head = `<head><meta name="generator" content="buildwithfern"></head>`;
    expect(detectProviderFromHtml(head)?.id).toBe("fern");
  });

  it("does not misdetect a non-Fern page as Fern", () => {
    expect(detectProviderFromHtml("<head><title>Some other site</title></head>")?.id).not.toBe(
      "fern",
    );
  });

  it("detects Fern's own domain by URL (no network)", () => {
    expect(detectFromUrl("https://buildwithfern.com/learn/docs/configuration/changelogs")?.id).toBe(
      "fern",
    );
  });
});

describe("Fern provider hints", () => {
  const hints = getProviderHints("fern");

  it("prefers the feed adapter", () => {
    expect(hints?.preferredType).toBe("feed");
  });

  it("covers both `.rss` changelog mount points", () => {
    // Fern appends `.rss` to the changelog path; the two common mounts are
    // /docs/changelog (→ /docs/changelog.rss) and /changelog (→ /changelog.rss).
    expect(hints?.feedPaths).toContain("/changelog.rss");
    expect(hints?.feedPaths).toContain("/docs/changelog.rss");
  });

  it("marks Fern content as statically rendered", () => {
    expect(hints?.staticContent).toBe(true);
  });

  it("omits markdownSuffix — the changelog index `.md` is a false-positive 404", () => {
    // /docs/changelog.md returns 200 text/plain "Page Not Found"; only individual
    // dated entries serve real markdown, and those are already covered by the feed.
    expect(hints?.markdownSuffix).toBeUndefined();
  });
});
