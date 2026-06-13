import { describe, test, expect } from "bun:test";
import { rewriteRelativeLinks, originFromUrl } from "./rewrite-links";

const BASE = "https://example.com/changelog/123";

// ── originFromUrl ────────────────────────────────────────────────────────────

describe("originFromUrl", () => {
  test("extracts origin from an https URL", () => {
    expect(originFromUrl("https://elevenlabs.io/changelog/audio-native")).toBe(
      "https://elevenlabs.io",
    );
  });

  test("extracts origin from an http URL", () => {
    expect(originFromUrl("http://example.com/foo")).toBe("http://example.com");
  });

  test("returns null for null input", () => {
    expect(originFromUrl(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(originFromUrl(undefined)).toBeNull();
  });

  test("returns null for a non-URL string", () => {
    expect(originFromUrl("not-a-url")).toBeNull();
  });

  test("returns null for mailto scheme", () => {
    expect(originFromUrl("mailto:hello@example.com")).toBeNull();
  });
});

// ── rewriteRelativeLinks ─────────────────────────────────────────────────────

describe("rewriteRelativeLinks", () => {
  // ── Root-relative links ──

  test("rewrites root-relative markdown link", () => {
    const md = "[Read the docs](/docs/api-reference)";
    expect(rewriteRelativeLinks(md, BASE)).toBe(
      "[Read the docs](https://example.com/docs/api-reference)",
    );
  });

  test("rewrites root-relative markdown image", () => {
    const md = "![Logo](/img/logo.png)";
    expect(rewriteRelativeLinks(md, BASE)).toBe("![Logo](https://example.com/img/logo.png)");
  });

  test("rewrites root-relative href attribute", () => {
    const md = `<a href="/docs/scroll">see docs</a>`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(
      `<a href="https://example.com/docs/scroll">see docs</a>`,
    );
  });

  test("rewrites root-relative src attribute", () => {
    const md = `<img src="/img/banner.png" alt="Banner">`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(
      `<img src="https://example.com/img/banner.png" alt="Banner">`,
    );
  });

  test("rewrites root-relative src attribute (single quotes)", () => {
    const md = `<img src='/img/banner.png' alt='Banner'>`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(
      `<img src='https://example.com/img/banner.png' alt='Banner'>`,
    );
  });

  // ── Protocol-relative links ──

  test("rewrites protocol-relative markdown link", () => {
    const md = "[CDN](//cdn.example.com/asset.js)";
    expect(rewriteRelativeLinks(md, BASE)).toBe("[CDN](https://cdn.example.com/asset.js)");
  });

  test("rewrites protocol-relative href attribute", () => {
    const md = `<a href="//cdn.example.com/style.css">styles</a>`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(
      `<a href="https://cdn.example.com/style.css">styles</a>`,
    );
  });

  // ── Bare-relative links ──

  test("rewrites ./relative markdown link", () => {
    const md = "[Next step](./next-step)";
    expect(rewriteRelativeLinks(md, BASE)).toBe("[Next step](https://example.com/next-step)");
  });

  test("rewrites ../relative markdown link", () => {
    const md = "[Go up](../parent-page)";
    expect(rewriteRelativeLinks(md, BASE)).toBe("[Go up](https://example.com/parent-page)");
  });

  // ── Already-absolute links must pass through untouched ──

  test("leaves absolute https link untouched", () => {
    const md = "[Docs](https://docs.example.com/api)";
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  test("leaves absolute http link untouched", () => {
    const md = "[Old](http://example.com/old)";
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  test("leaves absolute href attribute untouched", () => {
    const md = `<a href="https://example.com/page">link</a>`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  // ── Special schemes must pass through untouched ──

  test("leaves mailto: link untouched", () => {
    const md = "[Email](mailto:hello@example.com)";
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  test("leaves fragment-only link untouched", () => {
    const md = "[Jump](#section-2)";
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  test("leaves data: URI untouched in href", () => {
    const md = `<a href="data:text/plain,hello">data</a>`;
    expect(rewriteRelativeLinks(md, BASE)).toBe(md);
  });

  // ── No-op cases ──

  test("returns content unchanged when baseUrl is null", () => {
    const md = "[Docs](/docs/api)";
    expect(rewriteRelativeLinks(md, null)).toBe(md);
  });

  test("returns content unchanged when baseUrl is undefined", () => {
    const md = "[Docs](/docs/api)";
    expect(rewriteRelativeLinks(md, undefined)).toBe(md);
  });

  test("returns content unchanged when baseUrl is not http(s)", () => {
    const md = "[Docs](/docs/api)";
    expect(rewriteRelativeLinks(md, "ftp://example.com")).toBe(md);
  });

  test("returns empty string unchanged", () => {
    expect(rewriteRelativeLinks("", BASE)).toBe("");
  });

  // ── Mixed content ──

  test("rewrites multiple relative links in one body", () => {
    const md = [
      "Check [the API](/docs/api) and [the guide](/learn/guide).",
      "![Screenshot](/img/screen.png)",
    ].join("\n");

    const result = rewriteRelativeLinks(md, BASE);
    expect(result).toContain("(https://example.com/docs/api)");
    expect(result).toContain("(https://example.com/learn/guide)");
    expect(result).toContain("(https://example.com/img/screen.png)");
  });

  test("does not double-rewrite an already-absolute link", () => {
    const md = "[Docs](https://example.com/docs)";
    // Running twice should be idempotent
    const once = rewriteRelativeLinks(md, BASE);
    const twice = rewriteRelativeLinks(once, BASE);
    expect(once).toBe(twice);
    expect(once).toBe(md);
  });

  test("preserves markdown link title in parens", () => {
    const md = `[Docs](/docs "Documentation")`;
    const result = rewriteRelativeLinks(md, BASE);
    expect(result).toBe(`[Docs](https://example.com/docs "Documentation")`);
  });

  // ── Real-world patterns from the issue ──

  test("absolutizes ElevenLabs-style /docs path", () => {
    const base = "https://elevenlabs.io/changelog/audio-native";
    const md =
      "Check out the [Audio Native docs](/docs/api-reference/audio-native/update-content).";
    expect(rewriteRelativeLinks(md, base)).toBe(
      "Check out the [Audio Native docs](https://elevenlabs.io/docs/api-reference/audio-native/update-content).",
    );
  });

  test("absolutizes Upstash-style /qstash path", () => {
    const base = "https://upstash.com/changelog/2024-01";
    const md = "See [QStash schedules](/qstash/features/schedules) for details.";
    expect(rewriteRelativeLinks(md, base)).toBe(
      "See [QStash schedules](https://upstash.com/qstash/features/schedules) for details.",
    );
  });
});
