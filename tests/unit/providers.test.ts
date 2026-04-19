import { describe, it, expect } from "bun:test";
import {
  detectFromUrl,
  detectFromHttpSignals,
  detectProviderFromHtml,
  getProviderHints,
} from "../../src/lib/providers.js";

// ── detectFromUrl ───────────────────────────────────────────────────

describe("detectFromUrl", () => {
  it("detects Mintlify from URL hostname", () => {
    const result = detectFromUrl("https://docs.example.mintlify.app/changelog");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mintlify");
  });

  it("detects ReadMe from URL hostname", () => {
    const result = detectFromUrl("https://docs.example.readme.io/changelog");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("readme");
  });

  it("detects GitBook from URL hostname", () => {
    const result = detectFromUrl("https://docs.example.gitbook.io/docs");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("gitbook");
  });

  it("detects Hashnode from URL hostname", () => {
    const result = detectFromUrl("https://blog.example.hashnode.dev");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("hashnode");
  });

  it("detects Zendesk from URL hostname", () => {
    const result = detectFromUrl("https://help.example.zendesk.com/hc");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("zendesk");
  });

  it("detects Canny from URL hostname", () => {
    const result = detectFromUrl("https://feedback.example.canny.io");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("canny");
  });

  it("returns null for unknown URL", () => {
    const result = detectFromUrl("https://example.com/changelog");
    expect(result).toBeNull();
  });

  it("returns null for GitHub URL (not a provider)", () => {
    const result = detectFromUrl("https://github.com/vercel/next.js");
    expect(result).toBeNull();
  });
});

// ── detectFromHttpSignals ───────────────────────────────────────────

describe("detectFromHttpSignals", () => {
  it("detects Mintlify from headers", () => {
    const result = detectFromHttpSignals({
      headers: { "x-mintlify": "1" },
      headHtml: "",
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mintlify");
  });

  it("detects ReadMe from headers", () => {
    const result = detectFromHttpSignals({
      headers: { "x-readme-version": "3.0" },
      headHtml: "",
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("readme");
  });

  it("detects Ghost from headers", () => {
    const result = detectFromHttpSignals({
      headers: { "x-ghost-cache-status": "HIT" },
      headHtml: "",
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ghost");
  });

  it("detects Zendesk from headers", () => {
    const result = detectFromHttpSignals({
      headers: { "x-zendesk-request-id": "abc123" },
      headHtml: "",
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("zendesk");
  });

  it("detects Mintlify from HTML patterns", () => {
    const result = detectFromHttpSignals({
      headers: {},
      headHtml: '<script src="/__mintlify/app.js"></script>',
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mintlify");
  });

  it("detects Docusaurus from HTML patterns", () => {
    const result = detectFromHttpSignals({
      headers: {},
      headHtml: '<div id="__docusaurus"></div>',
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("docusaurus");
  });

  it("detects WordPress from HTML patterns", () => {
    const result = detectFromHttpSignals({
      headers: {},
      headHtml: '<link rel="api" href="/wp-json/wp/v2/posts">',
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("wordpress");
  });

  it("detects Vercel/Next.js from HTML patterns", () => {
    const result = detectFromHttpSignals({
      headers: {},
      headHtml: '<div id="__next"></div>',
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("vercel-docs");
  });

  it("returns null when no signals match", () => {
    const result = detectFromHttpSignals({
      headers: {},
      headHtml: "<html><body>Hello</body></html>",
    });
    expect(result).toBeNull();
  });
});

// ── detectProviderFromHtml ──────────────────────────────────────────

describe("detectProviderFromHtml", () => {
  it("detects provider from HTML string", () => {
    const result = detectProviderFromHtml('<div id="__docusaurus"></div>');
    expect(result).not.toBeNull();
    expect(result!.id).toBe("docusaurus");
    expect(result!.name).toBe("Docusaurus");
    expect(result!.hints).toBeDefined();
  });

  it("accepts optional headers parameter", () => {
    const result = detectProviderFromHtml("", { "x-ghost-cache-status": "HIT" });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ghost");
  });

  it("returns full DetectedProvider shape", () => {
    const result = detectProviderFromHtml('<script src="/__mintlify/init.js"></script>');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("hints");
  });

  it("returns null when nothing matches", () => {
    const result = detectProviderFromHtml("<html><head></head></html>");
    expect(result).toBeNull();
  });
});

// ── staticContent hint ──────────────────────────────────────────────

describe("staticContent hint", () => {
  it("docusaurus has staticContent: true", () => {
    const hints = getProviderHints("docusaurus");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("vitepress has staticContent: true", () => {
    const hints = getProviderHints("vitepress");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("nextra has staticContent: true", () => {
    const hints = getProviderHints("nextra");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("mintlify has staticContent: true", () => {
    const hints = getProviderHints("mintlify");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("ghost has staticContent: true", () => {
    const hints = getProviderHints("ghost");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("wordpress has staticContent: true", () => {
    const hints = getProviderHints("wordpress");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("hashnode has staticContent: true", () => {
    const hints = getProviderHints("hashnode");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).toBe(true);
  });

  it("notion does not have staticContent: true", () => {
    const hints = getProviderHints("notion");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).not.toBe(true);
  });

  it("vercel-docs does not have staticContent: true", () => {
    const hints = getProviderHints("vercel-docs");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).not.toBe(true);
  });

  it("gitbook does not have staticContent: true", () => {
    const hints = getProviderHints("gitbook");
    expect(hints).not.toBeNull();
    expect(hints!.staticContent).not.toBe(true);
  });
});

// ── getProviderHints ────────────────────────────────────────────────

describe("getProviderHints", () => {
  it("returns hints for mintlify", () => {
    const hints = getProviderHints("mintlify");
    expect(hints).not.toBeNull();
    expect(hints!.feedPaths).toBeDefined();
    expect(hints!.markdownSuffix).toBe(true);
  });

  it("returns hints for readme", () => {
    const hints = getProviderHints("readme");
    expect(hints).not.toBeNull();
    expect(hints!.feedPaths).toBeDefined();
  });

  it("returns hints for docusaurus", () => {
    const hints = getProviderHints("docusaurus");
    expect(hints).not.toBeNull();
    expect(hints!.feedPaths).toBeDefined();
  });

  it("returns hints for wordpress", () => {
    const hints = getProviderHints("wordpress");
    expect(hints).not.toBeNull();
    expect(hints!.feedPaths).toBeDefined();
  });

  it("returns null for unknown provider id", () => {
    const hints = getProviderHints("unknown-id");
    expect(hints).toBeNull();
  });

  it("each known provider has at least one useful hint field", () => {
    const ids = [
      "mintlify",
      "readme",
      "gitbook",
      "docusaurus",
      "ghost",
      "wordpress",
      "hashnode",
      "nextra",
      "vitepress",
      "notion",
      "vercel-docs",
      "intercom",
      "zendesk",
      "canny",
    ];
    for (const id of ids) {
      const hints = getProviderHints(id);
      expect(hints).not.toBeNull();
      const hasUsefulField =
        (hints!.feedPaths && hints!.feedPaths.length > 0) ||
        hints!.markdownSuffix !== undefined ||
        hints!.crawlPattern !== undefined ||
        hints!.preferredType !== undefined ||
        (hints!.changelogPaths && hints!.changelogPaths.length > 0);
      expect(hasUsefulField).toBe(true);
    }
  });
});
