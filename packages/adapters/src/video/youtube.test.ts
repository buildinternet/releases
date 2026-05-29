import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { youtubeProvider } from "./youtube";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../test/fixtures/youtube-playlist.xml"),
  "utf8",
);

describe("parseYouTubeFeed", () => {
  const parsed = youtubeProvider.parseFeed(FIXTURE);

  test("reads channel + playlist identity from the feed root", () => {
    expect(parsed.channel.id).toBe("UCV03SRZXJEz-hchIAogeJOg");
    expect(parsed.channel.title).toBe("Claude");
    expect(parsed.channel.playlistId).toBe("PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
    expect(parsed.channel.playlistTitle).toBe("Product Launches");
  });

  test("maps each entry to a RawRelease", () => {
    expect(parsed.releases).toHaveLength(2);
    const first = parsed.releases[0]!;
    expect(first.title).toBe("New agents for legal professionals | Claude Cowork");
    expect(first.url).toBe("https://www.youtube.com/watch?v=7-1tNo8HAwk");
    expect(first.content).toContain("tools built for the way legal teams work");
    // The description IS the content, not a summary of a fetchable page — so we
    // do NOT set contentFromSummary (it would wrongly trigger HTML feed-enrich).
    expect(first.contentFromSummary).toBeUndefined();
    expect(first.publishedAt?.toISOString()).toBe("2026-05-12T16:52:13.000Z");
    expect(first.media).toEqual([
      {
        type: "image",
        url: "https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg",
        alt: "New agents for legal professionals | Claude Cowork",
      },
    ]);
  });

  test("empty xml yields no releases and empty channel", () => {
    const empty = youtubeProvider.parseFeed("<feed></feed>");
    expect(empty.releases).toEqual([]);
  });

  test("single-entry feed (fast-xml-parser object-not-array path) yields one release", () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>UCtest</yt:channelId>
 <title>Solo Channel</title>
 <author><name>Solo</name></author>
 <entry>
  <yt:videoId>abc123</yt:videoId>
  <title>My Only Video</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
  <published>2026-01-01T00:00:00+00:00</published>
  <media:group><media:description>just one</media:description></media:group>
 </entry>
</feed>`;
    const parsedOne = youtubeProvider.parseFeed(xml);
    expect(parsedOne.releases).toHaveLength(1);
    expect(parsedOne.releases[0]!.title).toBe("My Only Video");
    expect(parsedOne.releases[0]!.url).toBe("https://www.youtube.com/watch?v=abc123");
    expect(parsedOne.releases[0]!.media).toEqual([]);
    expect(parsedOne.channel.title).toBe("Solo");
  });

  test("entry missing media:group still parses (empty content, no media)", () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <entry>
  <yt:videoId>noMedia1</yt:videoId>
  <title>No Media Group</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=noMedia1"/>
  <published>2026-01-02T00:00:00+00:00</published>
 </entry>
</feed>`;
    const r = youtubeProvider.parseFeed(xml).releases[0]!;
    expect(r.content).toBe("");
    expect(r.media).toEqual([]);
  });
});

describe("youtube resolveFeed", () => {
  test("playlist URL → playlist_id feed (no fetch)", async () => {
    const r = await youtubeProvider.resolveFeed(
      "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
    );
    expect(r.feedUrl).toBe(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
    );
    expect(r.channel.playlistId).toBe("PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
  });

  test("channel-id URL → channel_id feed (no fetch)", async () => {
    const r = await youtubeProvider.resolveFeed(
      "https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg",
    );
    expect(r.feedUrl).toBe(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg",
    );
    expect(r.channel.id).toBe("UCV03SRZXJEz-hchIAogeJOg");
  });

  test("@handle URL → scrapes channelId from page", async () => {
    const fakeFetch = (async () =>
      new Response('<html>...{"channelId":"UCabc123_-DEF"}...</html>', {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await youtubeProvider.resolveFeed("https://www.youtube.com/@claude", fakeFetch);
    expect(r.feedUrl).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UCabc123_-DEF");
    expect(r.channel.handle).toBe("@claude");
  });

  test("matchUrl recognizes youtube hosts", () => {
    expect(youtubeProvider.matchUrl("https://www.youtube.com/@x")).toBe(true);
    expect(youtubeProvider.matchUrl("https://youtu.be/abc")).toBe(true);
    expect(youtubeProvider.matchUrl("https://vimeo.com/123")).toBe(false);
  });
});
