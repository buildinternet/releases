import { describe, it, expect } from "bun:test";
import { htmlToMarkdown, parseRss } from "./feed";

function rssWithEncoded(body: string): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title>
<item><title>Release</title><link>https://ex.com/r1</link><pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item>
</channel></rss>`;
}

// Some feeds (e.g. OpenAI's Codex changelog, Auth0) put raw markdown in
// <content:encoded>, which the RSS spec reserves for HTML. Running Turndown
// over markdown escapes every #, [, *, ` and collapses the hard-wrapped
// newlines into a wall of text (see rel_HOLmi6zZTBBzrOqy5C4ig). parseRss keys
// off block-level HTML to decide whether a body is markdown or HTML.
describe("parseRss markdown content:encoded", () => {
  it("does not escape markdown delivered as plain text in content:encoded", () => {
    const body = `# Codex app

### New features

- Added rate-limit reset banking for Plus and Pro users, including one free
  reset at launch and
  [referral invitations](/codex/pricing#invite-friends-and-coworkers) for
  earning more during the current promotion.
- Added the \`/init\` command to the app composer.
- Added an **Unread chats** section to the command menu.`;
    const [release] = parseRss(rssWithEncoded(body));
    const out = release.content;

    // No backslash escapes introduced.
    expect(out).not.toContain("\\#");
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\*");
    expect(out).not.toContain("\\`");

    // Block structure (headings on their own lines) is preserved.
    expect(out).toContain("# Codex app");
    expect(out).toContain("### New features");
    expect(out).toContain("[referral invitations](/codex/pricing#invite-friends-and-coworkers)");
    expect(out).toContain("`/init`");
    expect(out).toContain("**Unread chats**");
    expect(out).not.toContain("# Codex app ###");
  });

  it("treats markdown with inline HTML (e.g. <kbd>) as markdown, not HTML", () => {
    // The Codex feed wraps key combos in <kbd> (decoded from &lt;kbd&gt;);
    // inline tags must not flip an otherwise-markdown body into the Turndown
    // path, which would escape the surrounding markdown.
    const body = `### Shortcuts

- Added <kbd>Cmd</kbd>+<kbd>Enter</kbd> as a shortcut, see [the docs](/docs).`;
    const [release] = parseRss(rssWithEncoded(body));
    const out = release.content;
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\#");
    expect(out).toContain("### Shortcuts");
    expect(out).toContain("[the docs](/docs)");
    expect(out).toContain("<kbd>Cmd</kbd>");
  });

  it("converts real HTML content:encoded via Turndown", () => {
    const [release] = parseRss(
      rssWithEncoded(
        '<h1>Title</h1><p>Some <strong>bold</strong> text with a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>',
      ),
    );
    const out = release.content;
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("[link](https://example.com)");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  it("extracts markdown-syntax images when content:encoded carries markdown", () => {
    const [release] = parseRss(
      rssWithEncoded(`# Heading

![a screenshot](https://media.example.com/shot.png)`),
    );
    expect(release.media).toEqual([
      { type: "image", url: "https://media.example.com/shot.png", alt: "a screenshot" },
    ]);
    expect(release.content).toContain("# Heading");
    expect(release.content).not.toContain("\\#");
  });
});

// htmlToMarkdown itself stays a pure HTML->markdown converter (its general
// contract is covered in tests/unit/feed-parsers.test.ts); this guards the
// one behaviour the feed-markdown path depends on.
describe("htmlToMarkdown stays a pure converter", () => {
  it("converts bare inline HTML (no block tags) via Turndown", () => {
    expect(htmlToMarkdown('<a href="https://example.com">link</a>')).toBe(
      "[link](https://example.com)",
    );
    expect(htmlToMarkdown('<img src="https://example.com/i.png" alt="x">')).toBe(
      "![x](https://example.com/i.png)",
    );
  });
});
