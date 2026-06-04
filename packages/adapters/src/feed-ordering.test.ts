import { describe, it, expect } from "bun:test";
import { fetchAndParseFeed } from "./feed";

function fetchReturning(xml: string): typeof fetch {
  return (async () =>
    new Response(xml, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    })) as unknown as typeof fetch;
}

// Oldest-first feed: items run oldest -> newest top-to-bottom, the way Hugo's
// default index.xml (e.g. releases.1password.com) emits them. A positional
// maxEntries cap must keep the NEWEST entries, not the oldest.
const OLDEST_FIRST_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title>
<item><title>v1.0</title><link>https://ex.com/1.0</link><pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate></item>
<item><title>v1.1</title><link>https://ex.com/1.1</link><pubDate>Thu, 01 Feb 2024 00:00:00 +0000</pubDate></item>
<item><title>v1.2</title><link>https://ex.com/1.2</link><pubDate>Fri, 01 Mar 2024 00:00:00 +0000</pubDate></item>
<item><title>v1.3</title><link>https://ex.com/1.3</link><pubDate>Mon, 01 Apr 2024 00:00:00 +0000</pubDate></item>
<item><title>v1.4</title><link>https://ex.com/1.4</link><pubDate>Wed, 01 May 2024 00:00:00 +0000</pubDate></item>
</channel></rss>`;

describe("fetchAndParseFeed maxEntries ordering", () => {
  it("keeps the newest entries when an oldest-first feed exceeds maxEntries", async () => {
    const { releases } = await fetchAndParseFeed(
      "https://ex.com/feed.xml",
      "rss",
      { maxEntries: 3 },
      undefined,
      fetchReturning(OLDEST_FIRST_RSS),
    );
    expect(releases.map((r) => r.title)).toEqual(["v1.4", "v1.3", "v1.2"]);
  });

  it("returns capped output newest-first regardless of feed document order", async () => {
    const { releases } = await fetchAndParseFeed(
      "https://ex.com/feed.xml",
      "rss",
      { maxEntries: 10 },
      undefined,
      fetchReturning(OLDEST_FIRST_RSS),
    );
    expect(releases.map((r) => r.title)).toEqual(["v1.4", "v1.3", "v1.2", "v1.1", "v1.0"]);
  });
});
