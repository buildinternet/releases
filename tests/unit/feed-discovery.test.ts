import { describe, it, expect, afterEach } from "bun:test";
import { discoverFeed } from "../../packages/adapters/src/feed";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Build a minimal stub for globalThis.fetch that routes requests by URL.
 *
 * Each entry in `routes` maps a URL string to a partial Response-like object:
 *   { status, contentType?, body? }
 *
 * Any URL not in the map returns 404.
 */
function mockFetch(
  routes: Record<string, { status: number; contentType?: string; body?: string }>,
): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    const entry = routes[url];
    if (!entry) {
      return new Response("Not Found", { status: 404 });
    }

    const headers: Record<string, string> = {};
    if (entry.contentType) {
      headers["content-type"] = entry.contentType;
    }

    // HEAD requests return no body
    if (init?.method === "HEAD") {
      return new Response(null, { status: entry.status, headers });
    }

    return new Response(entry.body ?? "", { status: entry.status, headers });
  };
}

// ── discoverFeed: <link rel="alternate"> wins first ────────────────

describe("discoverFeed: <link rel='alternate'> takes priority", () => {
  it("returns the feed from <head> before probing any paths", async () => {
    mockFetch({
      "https://example.com/changelog": {
        status: 200,
        contentType: "text/html",
        body: `<html><head>
          <link rel="alternate" type="application/rss+xml" href="/changelog/feed.xml" />
        </head><body></body></html>`,
      },
      // Even if a sibling path would also match, head should win.
      "https://example.com/changelog/rss.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/changelog");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/changelog/feed.xml");
    expect(result!.type).toBe("rss");
  });
});

// ── discoverFeed: sibling-path probing ─────────────────────────────

describe("discoverFeed: sibling-path probing", () => {
  it("discovers a sibling /rss.xml feed (the concrete Claude changelog case)", async () => {
    mockFetch({
      // Page with no <link rel="alternate">
      "https://code.claude.com/docs/en/changelog": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      // Sibling feed at {path}/rss.xml
      "https://code.claude.com/docs/en/changelog/rss.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://code.claude.com/docs/en/changelog");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://code.claude.com/docs/en/changelog/rss.xml");
    expect(result!.type).toBe("rss");
  });

  it("discovers a sibling /feed.xml feed", async () => {
    mockFetch({
      "https://example.com/docs/releases": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      "https://example.com/docs/releases/feed.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/docs/releases");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/docs/releases/feed.xml");
  });

  it("discovers a sibling .rss extension feed", async () => {
    mockFetch({
      "https://example.com/news/updates": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      "https://example.com/news/updates.rss": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/news/updates");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/news/updates.rss");
    expect(result!.type).toBe("rss");
  });

  it("trims trailing slash from page URL before appending sibling suffix", async () => {
    mockFetch({
      // Page URL with trailing slash
      "https://example.com/blog/": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      // Correctly trimmed path + suffix (no double slash)
      "https://example.com/blog/rss.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/blog/");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/blog/rss.xml");
  });
});

// ── discoverFeed: origin-root fallback still works ─────────────────

describe("discoverFeed: origin-root fallback", () => {
  it("falls back to origin-root well-known paths when sibling probes all miss", async () => {
    mockFetch({
      "https://example.com/blog": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      // All sibling probes return 404 (not in the map)
      // Origin-root /rss.xml succeeds
      "https://example.com/rss.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/blog");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/rss.xml");
    expect(result!.type).toBe("rss");
  });
});

// ── discoverFeed: root-page edge case ──────────────────────────────

describe("discoverFeed: root-page skips sibling probe", () => {
  it("does not double-probe when page URL is the origin root", async () => {
    // The root page pathname "/" trims to "" so sibling probes are skipped.
    // Only origin-root paths should be tried; confirm discovery succeeds via origin root.
    mockFetch({
      "https://example.com/": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      "https://example.com/rss.xml": {
        status: 200,
        contentType: "application/rss+xml",
      },
    });

    const result = await discoverFeed("https://example.com/");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/rss.xml");
  });

  it("returns null when no feed is found anywhere for a root-path page", async () => {
    mockFetch({
      "https://example.com/": {
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      },
      // All probes return 404 (not in map)
    });

    const result = await discoverFeed("https://example.com/");
    expect(result).toBeNull();
  });
});
