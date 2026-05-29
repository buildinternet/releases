import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAndParseVideoFeed } from "./index";
import { youtubeProvider } from "./youtube";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../test/fixtures/youtube-playlist.xml"),
  "utf8",
);

describe("fetchAndParseVideoFeed", () => {
  test("fetches, parses, and surfaces etag", async () => {
    const fakeFetch = (async () =>
      new Response(FIXTURE, {
        status: 200,
        headers: { etag: '"abc"' },
      })) as unknown as typeof fetch;
    const result = await fetchAndParseVideoFeed(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=X",
      youtubeProvider,
      undefined,
      fakeFetch,
    );
    expect(result.releases).toHaveLength(2);
    expect(result.channel.title).toBe("Claude");
    expect(result.etag).toBe('"abc"');
  });

  test("304 returns empty releases", async () => {
    const fakeFetch = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const result = await fetchAndParseVideoFeed(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=X",
      youtubeProvider,
      { "If-None-Match": '"abc"' },
      fakeFetch,
    );
    expect(result.releases).toEqual([]);
    expect(result.channel).toEqual({});
  });

  test("non-ok throws", async () => {
    const fakeFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchAndParseVideoFeed(
        "https://www.youtube.com/feeds/videos.xml?x",
        youtubeProvider,
        undefined,
        fakeFetch,
      ),
    ).rejects.toThrow();
  });
});
