import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { stripAnsi } from "../../src/lib/sanitize.js";

const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const { showSourceAction } = await import("../../src/cli/commands/source-show.js");

/** A scrape source addressed by typed id, with rich fetch-config metadata. */
const SOURCE = {
  id: "src_abc",
  name: "Release Notes",
  slug: "release-notes",
  type: "scrape",
  url: "https://example.com/release-notes",
  orgId: "org_1",
  orgSlug: "example",
  kind: "tool",
  isPrimary: true,
  isHidden: false,
  fetchPriority: "paused",
  lastFetchedAt: "2026-06-10T12:00:00Z",
  metadata: JSON.stringify({
    renderRequired: true,
    crawlEnabled: true,
    feedUrl: "https://example.com/feed.xml",
    parseInstructions: "Only keep entries under the Changelog heading.",
    customFlag: "kept",
  }),
};

describe("admin source show (#295)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWrite: typeof process.stdout.write;
  let originalLog: typeof console.log;
  let out: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWrite = process.stdout.write;
    originalLog = console.log;
    out = "";
    // The human view uses console.log; --json uses writeJson → stdout.write.
    // Capture both so either path's output lands in `out`.
    process.stdout.write = ((chunk: unknown) => {
      out += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      out += args.map(String).join(" ") + "\n";
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(SOURCE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    console.log = originalLog;
  });

  it("human view surfaces the operator config the issue asks for", async () => {
    await showSourceAction("src_abc", {});
    const text = stripAnsi(out);
    expect(text).toContain("src_abc"); // ID prominent
    expect(text).toContain("Render required");
    expect(text).toContain("Crawl enabled");
    expect(text).toContain("Parse instructions");
    expect(text).toContain("Only keep entries"); // preview body
    expect(text).toContain("paused"); // fetch priority
    expect(text).toContain("customFlag"); // unknown keys aren't hidden
  });

  it("--json returns metadata as a parsed object, not a JSON string", async () => {
    await showSourceAction("src_abc", { json: true });
    const parsed = JSON.parse(out);
    expect(typeof parsed.metadata).toBe("object");
    expect(parsed.metadata.renderRequired).toBe(true);
    expect(parsed.metadata.crawlEnabled).toBe(true);
    expect(parsed.method).toBe("feed"); // derived from feedUrl in metadata
    expect(parsed.id).toBe("src_abc");
  });
});
