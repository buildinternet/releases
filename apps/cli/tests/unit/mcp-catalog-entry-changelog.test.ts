import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// getApiUrl() memoizes the base URL process-wide on first resolution, so the
// env must be set before anything imports/calls into src/api (see
// release-refetch.test.ts for the same pattern).
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

// The SDK marks `_registeredTools` private in its .d.ts; the cast below opts
// out of that check so tests can invoke a tool's handler directly without
// standing up a stdio transport.
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function toolHandler(name: string): ToolHandler {
  const tools = (
    server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> }
  )._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`tool "${name}" not registered`);
  return tool.handler;
}

const SOURCE = {
  id: "src_abc123",
  slug: "next-js",
  name: "Next.js",
  type: "github",
  url: "https://github.com/vercel/next.js",
  lastFetchedAt: "2026-07-01T00:00:00.000Z",
};

const PRODUCT = {
  id: "prod_xyz789",
  slug: "next-js",
  name: "Next.js",
  category: "framework",
  description: "React framework",
  url: "https://nextjs.org",
};

const CHANGELOG_RESPONSE = {
  path: "CHANGELOG.md",
  filename: "CHANGELOG.md",
  url: "https://github.com/vercel/next.js/blob/canary/CHANGELOG.md",
  rawUrl: "https://raw.githubusercontent.com/vercel/next.js/canary/CHANGELOG.md",
  content: "## 15.1.0\n\n- Some change",
  bytes: 1200,
  fetchedAt: "2026-07-01T00:00:00.000Z",
  offset: 0,
  limit: 40000,
  nextOffset: null,
  totalChars: 1200,
  totalTokens: 300,
  truncated: false,
  truncatedAt: null,
  files: [
    { path: "CHANGELOG.md", filename: "CHANGELOG.md", url: "x", bytes: 1200, fetchedAt: "x" },
  ],
};

describe("get_catalog_entry changelog params", () => {
  let originalFetch: typeof globalThis.fetch;
  let requestedUrls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requestedUrls = [];
    globalThis.fetch = (async (url: string) => {
      requestedUrls.push(url);
      const u = new URL(url);
      if (u.pathname === "/v1/sources/src_abc123" && u.search === "") {
        return new Response(JSON.stringify(SOURCE), { status: 200 });
      }
      if (u.pathname === "/v1/sources/src_abc123/changelog") {
        return new Response(JSON.stringify(CHANGELOG_RESPONSE), { status: 200 });
      }
      if (u.pathname === "/v1/products/prod_xyz789") {
        return new Response(JSON.stringify(PRODUCT), { status: 200 });
      }
      // Telemetry fire-and-forget POST — accept anything else quietly.
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns plain source detail with no changelog params", async () => {
    const handler = toolHandler("get_catalog_entry");
    const result = await handler({ identifier: "src_abc123" });
    const text = result.content[0]!.text;
    expect(text).toContain("**Source: Next.js** _(source)_");
    expect(text).not.toContain("CHANGELOG.md");
    expect(requestedUrls.some((u) => u.includes("/changelog"))).toBe(false);
  });

  it("inlines the changelog slice when include_changelog is set", async () => {
    const handler = toolHandler("get_catalog_entry");
    const result = await handler({ identifier: "src_abc123", include_changelog: true });
    const text = result.content[0]!.text;
    expect(text).toContain("**Source: Next.js** _(source)_");
    expect(text).toContain("**CHANGELOG.md**");
    expect(text).toContain("Total tokens: 300");
    expect(text).toContain("## 15.1.0");
    expect(requestedUrls.some((u) => u.includes("/v1/sources/src_abc123/changelog"))).toBe(true);
  });

  it("forwards changelog_path/offset/limit/tokens as query params", async () => {
    const handler = toolHandler("get_catalog_entry");
    await handler({
      identifier: "src_abc123",
      changelog_path: "packages/next/CHANGELOG.md",
      changelog_offset: 100,
      changelog_limit: 5000,
      changelog_tokens: 2000,
    });
    const changelogCall = requestedUrls.find((u) => u.includes("/changelog"));
    expect(changelogCall).toBeDefined();
    const u = new URL(changelogCall!);
    expect(u.searchParams.get("path")).toBe("packages/next/CHANGELOG.md");
    expect(u.searchParams.get("offset")).toBe("100");
    expect(u.searchParams.get("limit")).toBe("5000");
    expect(u.searchParams.get("tokens")).toBe("2000");
  });

  it("degrades gracefully when changelog params are passed for a product", async () => {
    const handler = toolHandler("get_catalog_entry");
    const result = await handler({ identifier: "prod_xyz789", include_changelog: true });
    const text = result.content[0]!.text;
    expect(text).toContain("**Product: Next.js** _(product)_");
    expect(text).toContain("Changelog does not apply to products");
  });

  it("reports when no CHANGELOG file is tracked for a source", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/v1/sources/src_abc123" && u.search === "") {
        return new Response(JSON.stringify(SOURCE), { status: 200 });
      }
      if (u.pathname === "/v1/sources/src_abc123/changelog") {
        return new Response("null", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const handler = toolHandler("get_catalog_entry");
    const result = await handler({ identifier: "src_abc123", include_changelog: true });
    const text = result.content[0]!.text;
    expect(text).toContain("No CHANGELOG file is tracked");
  });

  it("rejects a traversal-shaped changelog_path before any request is built", async () => {
    const handler = toolHandler("get_catalog_entry");
    await expect(
      handler({ identifier: "src_abc123", changelog_path: "../../etc/passwd" }),
    ).rejects.toThrow(/path-traversal/);
    expect(requestedUrls.some((u) => u.includes("/changelog"))).toBe(false);
  });
});

describe("get_source_changelog (removed)", () => {
  it("is no longer registered", () => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools;
    expect(tools.get_source_changelog).toBeUndefined();
  });
});
