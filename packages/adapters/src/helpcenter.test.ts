import { test, expect, describe, afterEach } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  mapZendeskArticles,
  fetchZendeskArticles,
  fetchHelpCenter,
  type ZendeskArticle,
} from "./helpcenter.js";

// Restore the pristine fetch captured by the test preload (#1553). The shared
// tests/global-fetch helper isn't imported here — packages/adapters tsconfig
// rootDir ("src") forbids the cross-package path — so restore inline.
function restoreGlobalFetch() {
  globalThis.fetch = (globalThis as { __REAL_FETCH__?: typeof fetch }).__REAL_FETCH__!;
}

const baseUrl = "https://support.zendesk.com";
const feedUrl = `${baseUrl}/api/v2/help_center/en-us/sections/4405298847002/articles.json?per_page=100&sort_by=created_at&sort_order=desc`;

const article: ZendeskArticle = {
  id: 1,
  title: "Release notes through 2026-05-22",
  html_url: "https://support.zendesk.com/hc/en-us/articles/108-Release-notes",
  body: '<h2>Copilot</h2><p>New: <a href="/hc/en-us/articles/999">thing</a></p>',
  created_at: "2026-05-25T00:36:41Z",
  edited_at: "2026-05-25T00:40:12Z",
};

describe("mapZendeskArticles", () => {
  test("maps an article to a RawRelease with markdown content and the html_url", () => {
    const [r] = mapZendeskArticles([article], { baseUrl });
    expect(r.title).toBe("Release notes through 2026-05-22");
    expect(r.url).toBe("https://support.zendesk.com/hc/en-us/articles/108-Release-notes");
    expect(r.content).toContain("## Copilot");
    expect(r.publishedAt?.toISOString()).toBe("2026-05-25T00:36:41.000Z");
  });

  test("absolutizes root-relative links against baseUrl", () => {
    const [r] = mapZendeskArticles([article], { baseUrl });
    expect(r.content).toContain("https://support.zendesk.com/hc/en-us/articles/999");
    expect(r.content).not.toContain("](/hc/en-us/articles/999)");
  });

  test("classifies as rollup when releaseType is rollup", () => {
    const [r] = mapZendeskArticles([article], { baseUrl, releaseType: "rollup" });
    expect(r.type).toBe("rollup");
  });

  test("leaves type unset when no releaseType is configured", () => {
    const [r] = mapZendeskArticles([article], { baseUrl });
    expect(r.type).toBeUndefined();
  });

  test("extracts the first body image as hero media, absolutized", () => {
    const withImg: ZendeskArticle = {
      ...article,
      body: '<p><img src="/docs/banner.jpg" alt="banner"></p><h2>x</h2>',
    };
    const [r] = mapZendeskArticles([withImg], { baseUrl });
    expect(r.media?.[0]).toEqual({
      type: "image",
      url: "https://support.zendesk.com/docs/banner.jpg",
      alt: "banner",
    });
  });

  test("omits media when the body has no images", () => {
    const [r] = mapZendeskArticles([article], { baseUrl });
    expect(r.media).toBeUndefined();
  });

  test("leaves publishedAt unset for an unparseable created_at", () => {
    const [r] = mapZendeskArticles([{ ...article, created_at: "not-a-date" }], { baseUrl });
    expect(r.publishedAt).toBeUndefined();
  });

  test("skips articles with no title", () => {
    const out = mapZendeskArticles([{ ...article, title: "  " }], { baseUrl });
    expect(out).toHaveLength(0);
  });
});

afterEach(restoreGlobalFetch);

describe("fetchZendeskArticles", () => {
  test("follows next_page pagination and accumulates articles", async () => {
    const page2 = `${feedUrl}&page=2`;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("page=2")) {
        return new Response(JSON.stringify({ articles: [{ ...article, id: 2 }], next_page: null }));
      }
      return new Response(JSON.stringify({ articles: [{ ...article, id: 1 }], next_page: page2 }));
    }) as unknown as typeof fetch;
    const out = await fetchZendeskArticles(feedUrl);
    expect(out.map((a) => a.id)).toEqual([1, 2]);
  });

  test("stops after maxPages without exhausting next_page", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ articles: [article], next_page: `${feedUrl}&page=loop` }),
      );
    }) as unknown as typeof fetch;
    await fetchZendeskArticles(feedUrl, { maxPages: 3 });
    expect(calls).toBe(3);
  });

  test("returns the articles collected so far on a non-2xx page (never throws)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1)
        return new Response(
          JSON.stringify({ articles: [article], next_page: `${feedUrl}&page=2` }),
        );
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    const out = await fetchZendeskArticles(feedUrl);
    expect(out).toHaveLength(1);
  });

  test("returns [] on a network error (never throws)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await fetchZendeskArticles(feedUrl)).toEqual([]);
  });
});

function helpCenterSource(meta: Record<string, unknown>): Source {
  return { type: "feed", metadata: JSON.stringify(meta) } as Source;
}

describe("fetchHelpCenter", () => {
  test("reads feedUrl + metadata.helpCenter and returns mapped, classified releases", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ articles: [article], next_page: null }),
      )) as unknown as typeof fetch;
    const src = helpCenterSource({
      feedUrl,
      feedType: "jsonfeed",
      helpCenter: { provider: "zendesk", releaseType: "rollup" },
    });
    const releases = await fetchHelpCenter(src);
    expect(releases).toHaveLength(1);
    expect(releases[0].type).toBe("rollup");
    expect(releases[0].url).toBe(article.html_url);
  });

  test("returns [] when there is no helpCenter block", async () => {
    expect(await fetchHelpCenter(helpCenterSource({ feedUrl, feedType: "rss" }))).toEqual([]);
  });

  test("returns [] for an unknown provider", async () => {
    const src = helpCenterSource({ feedUrl, helpCenter: { provider: "helpscout" } });
    expect(await fetchHelpCenter(src)).toEqual([]);
  });
});
