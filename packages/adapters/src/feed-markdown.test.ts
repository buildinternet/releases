import { describe, it, expect } from "bun:test";
import { htmlToMarkdown, parseRss } from "./feed";

// Some feeds (e.g. OpenAI's Codex changelog) put raw markdown in
// <content:encoded>, which the RSS spec reserves for HTML. Running Turndown
// over markdown escapes every #, [, *, ` and collapses the hard-wrapped
// newlines into a wall of text (see rel_HOLmi6zZTBBzrOqy5C4ig). When the
// content has no HTML tags it is already markdown — pass it through untouched.
describe("htmlToMarkdown markdown passthrough", () => {
  it("does not escape markdown delivered as plain text in content:encoded", () => {
    const input = `# Codex app

### New features

- Added rate-limit reset banking for Plus and Pro users, including one free
  reset at launch and
  [referral invitations](/codex/pricing#invite-friends-and-coworkers) for
  earning more during the current promotion.
- Added the \`/init\` command to the app composer.
- Added an **Unread chats** section to the command menu.`;

    const out = htmlToMarkdown(input);

    // No backslash escapes introduced.
    expect(out).not.toContain("\\#");
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\*");
    expect(out).not.toContain("\\`");

    // Block structure (headings on their own lines) is preserved, not
    // collapsed into a single line.
    expect(out).toContain("# Codex app");
    expect(out).toContain("### New features");
    expect(out).toContain("[referral invitations](/codex/pricing#invite-friends-and-coworkers)");
    expect(out).toContain("`/init`");
    expect(out).toContain("**Unread chats**");
    // The heading must not run inline with the next block.
    expect(out).not.toContain("# Codex app ###");
  });

  it("still converts real HTML content via Turndown", () => {
    const out = htmlToMarkdown(
      '<h1>Title</h1><p>Some <strong>bold</strong> text with a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("[link](https://example.com)");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  it("returns plain text unchanged when it has neither markdown nor HTML", () => {
    expect(htmlToMarkdown("Just a short description.")).toBe("Just a short description.");
  });
});

describe("parseRss media extraction from markdown content:encoded", () => {
  it("extracts markdown-syntax images when content:encoded carries markdown", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title>
<item><title>Release</title><link>https://ex.com/r1</link><pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate><content:encoded># Heading

![a screenshot](https://media.example.com/shot.png)
</content:encoded></item>
</channel></rss>`;
    const [release] = parseRss(xml);
    expect(release.media).toEqual([
      { type: "image", url: "https://media.example.com/shot.png", alt: "a screenshot" },
    ]);
    // And the body markdown is preserved, not escaped.
    expect(release.content).toContain("# Heading");
    expect(release.content).not.toContain("\\#");
  });
});
