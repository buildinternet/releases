import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseRss,
  parseAtom,
  parseJsonFeed,
  classifyFeedMime,
  detectFeedTypeFromContent,
  extractVersionFromTitle,
  detectBreaking,
  htmlToMarkdown,
  decodeHtmlEntities,
  extractMedia,
  iframeSrcToWatchUrl,
  parseFeedLinks,
  getSourceMeta,
} from "@releases/adapters/feed";

const fixturesDir = join(import.meta.dirname, "../fixtures/feeds");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

// Cache fixtures at module level — they're immutable and small
const RSS_BASIC = readFixture("rss-basic.xml");
const ATOM_BASIC = readFixture("atom-basic.xml");
const JSONFEED_BASIC = readFixture("jsonfeed-basic.json");
const RSS_WITH_MEDIA = readFixture("rss-with-media.xml");

// ── RSS parsing ────────────────────────────────────────────────────

describe("parseRss", () => {
  it("parses basic RSS items (title, content, url, publishedAt)", () => {
    const releases = parseRss(RSS_BASIC);

    expect(releases).toHaveLength(2);
    expect(releases[0].title).toBe("v2.1.0 — Dashboard Redesign");
    expect(releases[0].url).toBe("https://acme.com/changelog/v2-1-0");
    expect(releases[0].publishedAt).toEqual(new Date("Mon, 15 Jan 2024 12:00:00 GMT"));
    expect(releases[0].content).toContain("redesigned the dashboard");
  });

  it("extracts version from title", () => {
    const releases = parseRss(RSS_BASIC);
    expect(releases[0].version).toBe("2.1.0");
    expect(releases[1].version).toBe("2.0.0");
  });

  it("detects breaking changes in content", () => {
    const releases = parseRss(RSS_BASIC);
    expect(releases[0].isBreaking).toBe(true);
    expect(releases[1].isBreaking).toBe(false);
  });

  it("handles CDATA content", () => {
    const releases = parseRss(RSS_BASIC);
    expect(releases[0].content).toBeTruthy();
    expect(releases[0].content).not.toContain("CDATA");
  });

  it("skips items without title", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <item><description>No title here</description></item>
  <item><title>Has Title</title><description>Content</description></item>
</channel></rss>`;
    const releases = parseRss(xml);
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toBe("Has Title");
  });

  it("produces empty content for title-only items (#234)", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Notion 3.4, part 2</title>
    <link>https://www.notion.so/releases/2026-04-14</link>
    <pubDate>Tue Apr 14 2026 00:00:00 GMT+0000</pubDate>
    <guid>https://www.notion.so/releases/2026-04-14</guid>
  </item>
  <item>
    <title>Notion 3.4</title>
    <link>https://www.notion.so/releases/2026-04-07</link>
    <pubDate>Tue Apr 07 2026 00:00:00 GMT+0000</pubDate>
  </item>
</channel></rss>`;
    const releases = parseRss(xml);
    expect(releases).toHaveLength(2);
    expect(releases[0].title).toBe("Notion 3.4, part 2");
    expect(releases[0].content).toBe("");
    expect(releases[0].url).toBe("https://www.notion.so/releases/2026-04-14");
    expect(releases[1].content).toBe("");
  });

  it("converts HTML content to markdown", () => {
    const releases = parseRss(RSS_BASIC);
    expect(releases[0].content).not.toContain("<p>");
    expect(releases[0].content).not.toContain("<strong>");
  });

  it("uses content:encoded when description is absent", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Encoded Content</title>
    <content:encoded><![CDATA[<p>Rich content here</p>]]></content:encoded>
  </item>
</channel></rss>`;
    const releases = parseRss(xml);
    expect(releases).toHaveLength(1);
    expect(releases[0].content).toContain("Rich content here");
  });

  it("prefers content:encoded over description when both are present", () => {
    // Mirrors the OpenAI Codex RSS shape: description is just the title
    // while content:encoded carries the actual body.
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Codex app</title>
    <description>Codex app</description>
    <content:encoded><![CDATA[<h2>New Features</h2><ul><li>Added plugin marketplace support.</li></ul>]]></content:encoded>
  </item>
</channel></rss>`;
    const releases = parseRss(xml);
    expect(releases).toHaveLength(1);
    expect(releases[0].content).toContain("plugin marketplace");
    expect(releases[0].content).not.toBe("Codex app");
  });

  it("extracts media from description", () => {
    const releases = parseRss(RSS_BASIC);
    expect(releases[0].media).toBeDefined();
    expect(releases[0].media!.length).toBeGreaterThanOrEqual(1);
    expect(releases[0].media![0].type).toBe("image");
    expect(releases[0].media![0].url).toBe("https://acme.com/img/dashboard.png");
    expect(releases[0].media![0].alt).toBe("New dashboard");
  });
});

// ── Atom parsing ───────────────────────────────────────────────────

describe("parseAtom", () => {
  it("parses basic Atom entries", () => {
    const releases = parseAtom(ATOM_BASIC);

    expect(releases).toHaveLength(2);
    expect(releases[0].title).toBe("v3.0.0 — Breaking: New Auth System");
    expect(releases[1].title).toBe("v2.5.0 — Performance Improvements");
  });

  it("extracts alternate link hrefs", () => {
    const releases = parseAtom(ATOM_BASIC);

    expect(releases[0].url).toBe("https://acme.com/releases/v3-0-0");
    expect(releases[1].url).toBe("https://acme.com/releases/v2-5-0");
  });

  it("parses updated dates", () => {
    const releases = parseAtom(ATOM_BASIC);

    expect(releases[0].publishedAt).toEqual(new Date("2024-03-01T10:00:00Z"));
    expect(releases[1].publishedAt).toEqual(new Date("2024-02-15T08:00:00Z"));
  });

  it("handles <content> vs <summary> fallback", () => {
    const releases = parseAtom(ATOM_BASIC);
    expect(releases[0].content).toContain("OAuth 2.0");
    expect(releases[1].content).toContain("Improved query performance");
  });

  it("falls back to <published> when <updated> is absent", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Published Only</title>
    <published>2024-06-01T12:00:00Z</published>
    <summary>Test</summary>
  </entry>
</feed>`;
    const releases = parseAtom(xml);
    expect(releases[0].publishedAt).toEqual(new Date("2024-06-01T12:00:00Z"));
  });

  it("detects breaking changes", () => {
    const releases = parseAtom(ATOM_BASIC);
    expect(releases[0].isBreaking).toBe(true);
    expect(releases[1].isBreaking).toBe(false);
  });

  it("extracts version from title", () => {
    const releases = parseAtom(ATOM_BASIC);
    expect(releases[0].version).toBe("3.0.0");
    expect(releases[1].version).toBe("2.5.0");
  });
});

// ── JSON Feed parsing ──────────────────────────────────────────────

describe("parseJsonFeed", () => {
  it("parses basic JSON Feed items", () => {
    const releases = parseJsonFeed(JSONFEED_BASIC);

    expect(releases).toHaveLength(2);
    expect(releases[0].title).toBe("v1.5.0 — New CLI Tool");
    expect(releases[0].url).toBe("https://acme.com/changelog/v1-5-0");
    expect(releases[0].publishedAt).toEqual(new Date("2024-04-01T00:00:00Z"));
  });

  it("uses content_text when available, falls back to content_html", () => {
    const releases = parseJsonFeed(JSONFEED_BASIC);
    expect(releases[1].content).toBe("Fixed authentication timeout issues.");
    expect(releases[0].content).toContain("Added a new CLI");
    expect(releases[0].content).not.toContain("<p>");
  });

  it("filters out items without title", () => {
    const json = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        { id: "1", content_text: "no title" },
        { id: "2", title: "Has Title", content_text: "content" },
      ],
    });
    const releases = parseJsonFeed(json);
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toBe("Has Title");
  });

  it("extracts version from title", () => {
    const releases = parseJsonFeed(JSONFEED_BASIC);
    expect(releases[0].version).toBe("1.5.0");
    expect(releases[1].version).toBe("1.4.0");
  });

  it("extracts media from content_html", () => {
    const releases = parseJsonFeed(JSONFEED_BASIC);
    expect(releases[0].media).toBeDefined();
    expect(releases[0].media!.length).toBeGreaterThanOrEqual(1);
    expect(releases[0].media![0].type).toBe("gif");
    expect(releases[0].media![0].url).toBe("https://acme.com/img/cli.gif");
  });
});

// ── Feed type detection ────────────────────────────────────────────

describe("classifyFeedMime", () => {
  it("detects RSS from content-type", () => {
    expect(classifyFeedMime("application/rss+xml")).toBe("rss");
    expect(classifyFeedMime("application/rss+xml; charset=utf-8")).toBe("rss");
  });

  it("detects Atom from content-type", () => {
    expect(classifyFeedMime("application/atom+xml")).toBe("atom");
  });

  it("detects JSON Feed from content-type", () => {
    expect(classifyFeedMime("application/feed+json")).toBe("jsonfeed");
  });

  it("detects JSON Feed from application/json", () => {
    expect(classifyFeedMime("application/json")).toBe("jsonfeed");
  });

  it("returns null for unknown content types", () => {
    expect(classifyFeedMime("text/html")).toBeNull();
    expect(classifyFeedMime("application/pdf")).toBeNull();
    expect(classifyFeedMime("")).toBeNull();
  });
});

describe("detectFeedTypeFromContent", () => {
  it("detects JSON Feed from content body", () => {
    expect(detectFeedTypeFromContent('{ "version": "https://jsonfeed.org/version/1.1" }')).toBe(
      "jsonfeed",
    );
  });

  it("detects Atom from content body", () => {
    expect(
      detectFeedTypeFromContent('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'),
    ).toBe("atom");
  });

  it("detects RSS from <rss> tag", () => {
    expect(detectFeedTypeFromContent('<?xml version="1.0"?><rss version="2.0">')).toBe("rss");
  });

  it("detects RSS from <channel> tag", () => {
    expect(detectFeedTypeFromContent('<?xml version="1.0"?><channel>')).toBe("rss");
  });

  it("returns null for unknown content", () => {
    expect(detectFeedTypeFromContent("<html><body>Hello</body></html>")).toBeNull();
    expect(detectFeedTypeFromContent("plain text")).toBeNull();
  });
});

// ── HTML to Markdown conversion ────────────────────────────────────

describe("htmlToMarkdown", () => {
  it("converts images to markdown", () => {
    const html = '<img src="https://example.com/img.png" alt="Screenshot" />';
    expect(htmlToMarkdown(html)).toBe("![Screenshot](https://example.com/img.png)");
  });

  it("converts images with alt before src", () => {
    const html = '<img alt="Demo" src="https://example.com/demo.png" />';
    expect(htmlToMarkdown(html)).toBe("![Demo](https://example.com/demo.png)");
  });

  it("converts images without alt text", () => {
    const html = '<img src="https://example.com/img.png" />';
    expect(htmlToMarkdown(html)).toBe("![](https://example.com/img.png)");
  });

  it("converts links to markdown", () => {
    const html = '<a href="https://example.com">Click here</a>';
    expect(htmlToMarkdown(html)).toBe("[Click here](https://example.com)");
  });

  it("strips unsafe link schemes (keeps only text)", () => {
    const html = '<a href="javascript:alert(1)">XSS</a>';
    expect(htmlToMarkdown(html)).toBe("XSS");
  });

  it("converts bold and paragraph formatting", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    expect(htmlToMarkdown(html)).toBe("Hello **world**");
  });

  it("converts headings", () => {
    expect(htmlToMarkdown("<h2>Section</h2>")).toBe("## Section");
    expect(htmlToMarkdown("<h3>Subsection</h3>")).toBe("### Subsection");
  });

  it("converts inline code", () => {
    expect(htmlToMarkdown("Use <code>npm install</code> to install")).toBe(
      "Use `npm install` to install",
    );
  });

  it("converts italic", () => {
    expect(htmlToMarkdown("This is <em>important</em>")).toBe("This is *important*");
  });

  it("converts list items", () => {
    const html = "<ul><li>First</li><li>Second</li></ul>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("- First");
    expect(result).toContain("- Second");
  });

  it("converts fenced code blocks", () => {
    const html = "<pre><code>const x = 1;</code></pre>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
  });

  it("decodes HTML entities inside code blocks", () => {
    const html = "<pre><code>a &amp; b &gt; c</code></pre>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("a & b > c");
  });

  it("strips Fern visual editor attributes", () => {
    const html = '<h3 fve-data-id="abc123" fve-mdx-b64="IyMjIEhlbGxv">Hello</h3>';
    expect(htmlToMarkdown(html)).toBe("### Hello");
  });

  it("handles iframe embeds (YouTube)", () => {
    const html = '<iframe src="https://www.youtube.com/embed/abc123" width="560"></iframe>';
    const result = htmlToMarkdown(html);
    expect(result).toContain("[Video](https://www.youtube.com/watch?v=abc123)");
  });

  it("handles iframe embeds (Vimeo)", () => {
    const html = '<iframe src="https://player.vimeo.com/video/999" width="640"></iframe>';
    const result = htmlToMarkdown(html);
    expect(result).toContain("[Video](https://vimeo.com/999)");
  });

  it("handles iframe embeds (Loom)", () => {
    const html = '<iframe src="https://www.loom.com/embed/xyz789" width="640"></iframe>';
    const result = htmlToMarkdown(html);
    expect(result).toContain("[Video](https://www.loom.com/share/xyz789)");
  });

  it("converts video elements to links", () => {
    const html = '<video src="https://example.com/video.mp4"></video>';
    const result = htmlToMarkdown(html);
    expect(result).toContain("[Video](https://example.com/video.mp4)");
  });

  it("replaces &nbsp; with spaces", () => {
    const html = "Hello&nbsp;World";
    expect(htmlToMarkdown(html)).toBe("Hello World");
  });
});

// ── Version extraction ─────────────────────────────────────────────

describe("extractVersionFromTitle", () => {
  it("extracts semver with v prefix", () => {
    expect(extractVersionFromTitle("v2.1.0 — Dashboard Redesign")).toBe("2.1.0");
  });

  it("extracts semver without v prefix", () => {
    expect(extractVersionFromTitle("Release 2.1.0")).toBe("2.1.0");
  });

  it("extracts two-segment version", () => {
    expect(extractVersionFromTitle("Version 3.5 released")).toBe("3.5");
  });

  it("extracts pre-release version", () => {
    expect(extractVersionFromTitle("v4.0.0-beta.1 Preview")).toBe("4.0.0-beta.1");
  });

  it("returns undefined when no version present", () => {
    expect(extractVersionFromTitle("Bug fixes and improvements")).toBeUndefined();
    expect(extractVersionFromTitle("January Update")).toBeUndefined();
  });

  it("extracts version from middle of title", () => {
    expect(extractVersionFromTitle("Released: v1.0.0 is here!")).toBe("1.0.0");
  });
});

// ── Breaking change detection ──────────────────────────────────────

describe("detectBreaking", () => {
  it('detects "breaking change" text', () => {
    expect(detectBreaking("Update", "This is a breaking change in the API")).toBe(true);
  });

  it('detects "breaking:" prefix', () => {
    expect(detectBreaking("Breaking: New auth system", "Content here")).toBe(true);
  });

  it("detects warning character", () => {
    expect(detectBreaking("⚠ Important update", "Be careful")).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(detectBreaking("New Feature", "Added a button")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(detectBreaking("BREAKING CHANGE", "content")).toBe(true);
    expect(detectBreaking("title", "BREAKING CHANGE in API")).toBe(true);
  });
});

// ── HTML entity decoding ───────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  it("decodes &amp;", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("decodes &lt; and &gt;", () => {
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
  });

  it("decodes &quot;", () => {
    expect(decodeHtmlEntities("He said &quot;hello&quot;")).toBe('He said "hello"');
  });

  it("decodes &#39; (numeric entity)", () => {
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
  });

  it("decodes &apos;", () => {
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it("decodes hex entities like &#x27;", () => {
    expect(decodeHtmlEntities("&#x27;")).toBe("'");
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
  });

  it("decodes decimal entities like &#169;", () => {
    expect(decodeHtmlEntities("&#169;")).toBe("\u00A9"); // copyright symbol
  });

  it("handles multiple entities in one string", () => {
    expect(decodeHtmlEntities("&lt;a href=&quot;/&quot;&gt;")).toBe('<a href="/">');
  });
});

// ── Media extraction ───────────────────────────────────────────────

describe("extractMedia", () => {
  it("extracts images with alt text", () => {
    const html = '<img src="https://example.com/img.png" alt="Screenshot" />';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({
      type: "image",
      url: "https://example.com/img.png",
      alt: "Screenshot",
    });
  });

  it("identifies GIFs", () => {
    const html = '<img src="https://example.com/demo.gif" alt="Demo" />';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("gif");
  });

  it("extracts YouTube iframe embeds", () => {
    const html = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560"></iframe>';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("video");
    expect(media[0].url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("extracts Vimeo iframe embeds", () => {
    const html = '<iframe src="https://player.vimeo.com/video/123456789" width="640"></iframe>';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("video");
    expect(media[0].url).toBe("https://vimeo.com/123456789");
  });

  it("extracts Loom iframe embeds", () => {
    const html = '<iframe src="https://www.loom.com/embed/abc123def456" width="640"></iframe>';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("video");
    expect(media[0].url).toBe("https://www.loom.com/share/abc123def456");
  });

  it("extracts video elements", () => {
    const html = '<video src="https://example.com/video.mp4"></video>';
    const media = extractMedia(html);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("video");
    expect(media[0].url).toBe("https://example.com/video.mp4");
  });

  it("rejects javascript: URLs (XSS prevention)", () => {
    const html = '<img src="javascript:alert(1)" alt="XSS" />';
    const media = extractMedia(html);
    expect(media).toHaveLength(0);
  });

  it("extracts all media from a rich feed item", () => {
    const media = parseRss(RSS_WITH_MEDIA)[0].media!;

    expect(media).toHaveLength(6);
    expect(media.filter((m) => m.type === "image")).toHaveLength(1);
    expect(media.filter((m) => m.type === "gif")).toHaveLength(1);
    expect(media.filter((m) => m.type === "video")).toHaveLength(4);
    expect(media.every((m) => !m.url.startsWith("javascript:"))).toBe(true);
  });
});

// ── iframe URL conversion ──────────────────────────────────────────

describe("iframeSrcToWatchUrl", () => {
  it("converts YouTube embed to watch URL", () => {
    expect(iframeSrcToWatchUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("converts Vimeo player to direct URL", () => {
    expect(iframeSrcToWatchUrl("https://player.vimeo.com/video/123456789")).toBe(
      "https://vimeo.com/123456789",
    );
  });

  it("converts Loom embed to share URL", () => {
    expect(iframeSrcToWatchUrl("https://www.loom.com/embed/abc123")).toBe(
      "https://www.loom.com/share/abc123",
    );
  });

  it("adds https: to protocol-relative URLs", () => {
    expect(iframeSrcToWatchUrl("//www.example.com/embed/video")).toBe(
      "https://www.example.com/embed/video",
    );
  });

  it("returns original URL for unknown embed sources", () => {
    expect(iframeSrcToWatchUrl("https://example.com/embed/123")).toBe(
      "https://example.com/embed/123",
    );
  });

  it("handles YouTube with query params", () => {
    expect(iframeSrcToWatchUrl("https://www.youtube.com/embed/abc123?autoplay=1")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });
});

// ── parseFeedLinks ─────────────────────────────────────────────────

describe("parseFeedLinks", () => {
  it("parses RSS link tags from HTML head", () => {
    const head = `<head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
    </head>`;
    const result = parseFeedLinks(head, "https://example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("rss");
    expect(result!.url).toBe("https://example.com/feed.xml");
  });

  it("parses Atom link tags", () => {
    const head = `<link rel="alternate" type="application/atom+xml" href="/atom.xml" />`;
    const result = parseFeedLinks(head, "https://example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("atom");
    expect(result!.url).toBe("https://example.com/atom.xml");
  });

  it("parses JSON Feed link tags", () => {
    const head = `<link rel="alternate" type="application/feed+json" href="/feed.json" />`;
    const result = parseFeedLinks(head, "https://example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("jsonfeed");
    expect(result!.url).toBe("https://example.com/feed.json");
  });

  it("prefers JSON Feed when multiple types present", () => {
    const head = `
      <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
      <link rel="alternate" type="application/feed+json" href="/feed.json" />
      <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
    `;
    const result = parseFeedLinks(head, "https://example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("jsonfeed");
    expect(result!.url).toBe("https://example.com/feed.json");
  });

  it("returns null when no feed links found", () => {
    const head = `<head><link rel="stylesheet" href="/style.css" /></head>`;
    expect(parseFeedLinks(head, "https://example.com")).toBeNull();
  });

  it("returns null for empty head", () => {
    expect(parseFeedLinks("", "https://example.com")).toBeNull();
  });

  it("resolves relative URLs against base", () => {
    const head = `<link rel="alternate" type="application/rss+xml" href="../feed.xml" />`;
    const result = parseFeedLinks(head, "https://example.com/blog/");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/feed.xml");
  });

  it("handles absolute URLs in href", () => {
    const head = `<link rel="alternate" type="application/rss+xml" href="https://cdn.example.com/feed.xml" />`;
    const result = parseFeedLinks(head, "https://example.com");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://cdn.example.com/feed.xml");
  });
});

// ── getSourceMeta ──────────────────────────────────────────────────

describe("getSourceMeta", () => {
  it("parses valid JSON metadata", () => {
    const source = {
      metadata: '{"feedUrl":"https://example.com/feed.xml","feedType":"rss"}',
    } as any;
    const meta = getSourceMeta(source);
    expect(meta.feedUrl).toBe("https://example.com/feed.xml");
    expect(meta.feedType).toBe("rss");
  });

  it("returns empty object for null metadata", () => {
    const source = { metadata: null } as any;
    const meta = getSourceMeta(source);
    expect(meta).toEqual({});
  });

  it("returns empty object for undefined metadata", () => {
    const source = { metadata: undefined } as any;
    const meta = getSourceMeta(source);
    expect(meta).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const source = { metadata: "not json at all" } as any;
    const meta = getSourceMeta(source);
    expect(meta).toEqual({});
  });

  it("returns empty object for empty string metadata", () => {
    const source = { metadata: "" } as any;
    const meta = getSourceMeta(source);
    expect(meta).toEqual({});
  });
});
