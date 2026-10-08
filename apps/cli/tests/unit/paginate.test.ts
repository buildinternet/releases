import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { Command } from "commander";
import { streamAllPages, handlePageAll, type PageResult } from "../../src/lib/paginate.js";

/** Run `fn`, capturing everything written to stdout; returns the captured text. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

/** Parse NDJSON (one JSON value per non-empty line). */
function parseNdjson(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("streamAllPages", () => {
  it("walks every page and streams one NDJSON line per item", async () => {
    const pages: Array<PageResult<{ id: number }>> = [
      { items: [{ id: 1 }, { id: 2 }], hasMore: true },
      { items: [{ id: 3 }], hasMore: false },
    ];
    let total = 0;
    const out = await captureStdout(async () => {
      total = await streamAllPages((page) => Promise.resolve(pages[page - 1]!));
    });
    expect(total).toBe(3);
    expect(parseNdjson(out)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("applies the projector before writing each line", async () => {
    const out = await captureStdout(async () => {
      await streamAllPages(
        () => Promise.resolve({ items: [{ id: 1, secret: "x" }], hasMore: false }),
        (row) => ({ id: row.id }),
      );
    });
    expect(parseNdjson(out)).toEqual([{ id: 1 }]);
  });

  it("stops on an empty page even if the backend keeps reporting hasMore", async () => {
    let calls = 0;
    const out = await captureStdout(async () => {
      await streamAllPages(() => {
        calls++;
        // Always claims more, but the second page is empty → must stop.
        return Promise.resolve(
          calls === 1 ? { items: [{ id: 1 }], hasMore: true } : { items: [], hasMore: true },
        );
      });
    });
    expect(calls).toBe(2);
    expect(parseNdjson(out)).toEqual([{ id: 1 }]);
  });

  it("requests pages sequentially starting from page 1", async () => {
    const requested: number[] = [];
    await captureStdout(async () => {
      await streamAllPages((page) => {
        requested.push(page);
        return Promise.resolve({ items: [{ page }], hasMore: page < 3 });
      });
    });
    expect(requested).toEqual([1, 2, 3]);
  });
});

const noopFetch = () => Promise.resolve({ items: [{ id: 1 }], hasMore: false });

describe("handlePageAll", () => {
  it("returns false without streaming when --page-all is absent", async () => {
    let called = false;
    const out = await captureStdout(async () => {
      const handled = await handlePageAll({ json: true }, () => {
        called = true;
        return noopFetch();
      });
      expect(handled).toBe(false);
    });
    expect(called).toBe(false);
    expect(out).toBe("");
  });

  it("warns and returns false (falls through) when --page-all lacks --json", async () => {
    let called = false;
    const out = await captureStdout(async () => {
      const handled = await handlePageAll({ pageAll: true, json: false }, () => {
        called = true;
        return noopFetch();
      });
      expect(handled).toBe(false);
    });
    expect(called).toBe(false);
    expect(out).toBe("");
  });

  it("streams and returns true with --page-all --json", async () => {
    const out = await captureStdout(async () => {
      const handled = await handlePageAll({ pageAll: true, json: true }, noopFetch);
      expect(handled).toBe(true);
    });
    expect(parseNdjson(out)).toEqual([{ id: 1 }]);
  });
});

// ── Integration: `list --page-all` streams every page as NDJSON ──
describe("list --page-all", () => {
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

  let originalFetch: typeof globalThis.fetch;
  let exitSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    // Two pages of sources keyed off the ?page= query param.
    globalThis.fetch = (async (url: string) => {
      const page = new URL(url).searchParams.get("page");
      const body =
        page === "1"
          ? {
              items: [{ id: "src_1", slug: "a", name: "A", type: "feed", metadata: null }],
              pagination: { page: 1, pageSize: 1, returned: 1, hasMore: true },
            }
          : {
              items: [{ id: "src_2", slug: "b", name: "B", type: "feed", metadata: null }],
              pagination: { page: 2, pageSize: 1, returned: 1, hasMore: false },
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    exitSpy.mockRestore();
  });

  it("streams every source across pages as one-per-line NDJSON", async () => {
    const { registerListCommand } = await import("../../src/cli/commands/list.js");
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    const out = await captureStdout(async () => {
      await program.parseAsync(["list", "--json", "--page-all", "--limit", "1"], { from: "user" });
    });
    const rows = parseNdjson(out) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["src_1", "src_2"]);
  });

  it("rejects --page-all combined with --page", async () => {
    const { registerListCommand } = await import("../../src/cli/commands/list.js");
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await expect(
      program.parseAsync(["list", "--json", "--page-all", "--page", "2"], { from: "user" }),
    ).rejects.toThrow(/process\.exit/);
  });
});
