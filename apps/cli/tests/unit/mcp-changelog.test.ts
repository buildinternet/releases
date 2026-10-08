import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  delete process.env.RELEASES_API_KEY;
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const { server } = await import("../../src/mcp/server.js");

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function toolHandler(name: string): ToolHandler {
  const tools = (
    server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> }
  )._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`tool "${name}" not registered`);
  return tool.handler;
}

const LATEST_BODY = {
  releases: [
    {
      id: "rel_platform",
      version: null,
      title: "September 9, 2026",
      summary: "Source changelog pages no longer 500.",
      publishedAt: "2026-09-09T12:00:00.000Z",
      media: [],
      source: { slug: "product-changelog", name: "Changelog", type: "agent" },
      importance: 2,
    },
  ],
};

describe("MCP changelog tool", () => {
  let originalFetch: typeof globalThis.fetch;
  let requestedUrls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requestedUrls = [];
    globalThis.fetch = (async (url: string) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify(LATEST_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is registered", () => {
    expect(toolHandler("changelog")).toBeTypeOf("function");
  });

  it("returns recent entries and the website URL", async () => {
    const result = await toolHandler("changelog")({ limit: 1 });
    const parsed = JSON.parse(result.content[0]!.text) as {
      url: string;
      entries: Array<{ id: string; kind: string; title: string }>;
    };
    expect(parsed.url).toBe("https://releases.sh/updates");
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        id: "rel_platform",
        kind: "platform",
        title: "September 9, 2026",
      }),
    ]);
    expect(requestedUrls.some((u) => u.includes("/v1/releases/latest"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("org=releases-sh"))).toBe(true);
  });
});
