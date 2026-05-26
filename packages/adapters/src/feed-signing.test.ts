import { describe, it, expect } from "bun:test";
import { headCheckUrl, bodyHashCheck, fetchAndParseFeed } from "./feed";

function recordingFetch(response: () => Response) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return response();
  }) as typeof fetch;
  return { calls, impl };
}

describe("feed.ts fetchImpl injection", () => {
  it("headCheckUrl uses the injected fetchImpl", async () => {
    const { calls, impl } = recordingFetch(() => new Response("", { status: 304 }));
    await headCheckUrl("https://example.com/feed.xml", {}, impl);
    expect(calls).toEqual(["https://example.com/feed.xml"]);
  });

  it("bodyHashCheck uses the injected fetchImpl", async () => {
    const { calls, impl } = recordingFetch(() => new Response("<rss></rss>", { status: 200 }));
    await bodyHashCheck("https://example.com/page", undefined, undefined, impl);
    expect(calls).toEqual(["https://example.com/page"]);
  });

  it("fetchAndParseFeed uses the injected fetchImpl", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`;
    const { calls, impl } = recordingFetch(
      () => new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } }),
    );
    await fetchAndParseFeed("https://example.com/feed.xml", "rss", undefined, undefined, impl);
    expect(calls).toEqual(["https://example.com/feed.xml"]);
  });
});
