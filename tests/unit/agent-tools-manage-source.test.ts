import { describe, it, expect } from "bun:test";
import { createTypedExecutor } from "../../src/shared/agent-tools.js";

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function makeFetcher(responses: Response[]) {
  const recorded: RecordedRequest[] = [];
  let i = 0;
  return {
    recorded,
    fetcher: {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = new URL(typeof input === "string" ? input : input.toString());
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        recorded.push({
          method: init?.method ?? "GET",
          path: url.pathname.replace(/^\/v1/, "") + url.search,
          body,
        });
        const res = responses[i++];
        if (!res) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
        return res;
      },
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("manage_source(add) metadata construction (#700)", () => {
  it("includes feedType alongside feedUrl in metadata when evaluator returns both", async () => {
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({
        recommendedMethod: "feed",
        recommendedUrl: "https://example.com/atom.xml",
        feedUrl: "https://example.com/atom.xml",
        feedType: "atom",
        confidence: "high",
      }),
      jsonResponse({ id: "src_test", slug: "example" }, 201),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "add",
      name: "Example",
      url: "https://example.com",
    });

    const post = recorded[1];
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/sources");
    expect(post.body?.type).toBe("feed");
    expect(post.body?.metadata).toBe(
      JSON.stringify({ feedUrl: "https://example.com/atom.xml", feedType: "atom" }),
    );
  });

  it("demotes type=feed to type=scrape when feedType cannot be determined", async () => {
    // Without this guard, the source is created with type=feed and incomplete
    // metadata, so fetchOne fails forever with "Missing feedUrl or feedType".
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({
        recommendedMethod: "scrape",
        recommendedUrl: "https://example.com",
        confidence: "low",
      }),
      jsonResponse({ id: "src_test", slug: "example" }, 201),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "add",
      name: "Example",
      url: "https://example.com",
      type: "feed",
      feed_url: "https://example.com/feed",
    });

    const post = recorded[1];
    expect(post.body?.type).toBe("scrape");
    expect(post.body?.metadata).toBeUndefined();
  });

  it("auto-evaluates when caller passes type=feed without feed_url/feed_type", async () => {
    // Caller picked type=feed but didn't pre-fill metadata. Skipping the
    // evaluator would silently demote to scrape; instead, fill in feedUrl +
    // feedType from /evaluate so the source lands as a real feed source.
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({
        recommendedMethod: "feed",
        recommendedUrl: "https://example.com/atom.xml",
        feedUrl: "https://example.com/atom.xml",
        feedType: "atom",
        confidence: "high",
      }),
      jsonResponse({ id: "src_test", slug: "example" }, 201),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "add",
      name: "Example",
      url: "https://example.com",
      type: "feed",
    });

    const post = recorded[1];
    expect(post.body?.type).toBe("feed");
    expect(post.body?.metadata).toBe(
      JSON.stringify({ feedUrl: "https://example.com/atom.xml", feedType: "atom" }),
    );
  });

  it("uses caller-supplied feed_type without re-evaluating", async () => {
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({ id: "src_test", slug: "example" }, 201),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "add",
      name: "Example",
      url: "https://example.com",
      type: "feed",
      feed_url: "https://example.com/feed.xml",
      feed_type: "rss",
    });

    expect(recorded).toHaveLength(1);
    const post = recorded[0];
    expect(post.method).toBe("POST");
    expect(post.body?.type).toBe("feed");
    expect(post.body?.metadata).toBe(
      JSON.stringify({ feedUrl: "https://example.com/feed.xml", feedType: "rss" }),
    );
  });
});
