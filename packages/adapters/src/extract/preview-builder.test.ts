import { describe, expect, test } from "bun:test";
import { buildHtmlPreview, buildJsonSketch, buildPreview } from "./preview-builder.js";

describe("buildJsonSketch — strict parse", () => {
  test("returns top-level keys with types", () => {
    const body = JSON.stringify({ foo: "bar", count: 3, flag: true, items: [] });
    const result = buildJsonSketch(body);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("strict");
    expect(result.sketch).toContain("foo: string");
    expect(result.sketch).toContain("count: number");
    expect(result.sketch).toContain("flag: boolean");
    expect(result.sketch).toContain("items: array(len=0)");
  });

  test("walks to depth 2 for nested objects", () => {
    const body = JSON.stringify({
      result: { data: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    });
    const result = buildJsonSketch(body);
    expect(result.sketch).toContain("result:");
    expect(result.sketch).toContain("data:");
    // Depth-2: nodes is seen but not its interior
    expect(result.sketch).toContain("nodes: array(len=3)");
    expect(result.sketch).not.toContain("id: number");
  });

  test("reports array lengths for top-level arrays", () => {
    // oxlint-disable-next-line unicorn/no-new-array -- spec fixture: single numeric arg is intentionally the array length
    const body = JSON.stringify(new Array(42).fill({ a: 1 }));
    const result = buildJsonSketch(body);
    expect(result.ok).toBe(true);
    expect(result.sketch).toContain("[root]: array(len=42)");
  });
});

describe("buildJsonSketch — partial parse", () => {
  test("recovers schema from a truncated JSON prefix", () => {
    const full = JSON.stringify({
      componentChunkName: "xyz",
      result: { data: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    });
    const truncated = full.slice(0, Math.floor(full.length * 0.6));
    const result = buildJsonSketch(truncated);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("partial");
    expect(result.sketch).toContain("componentChunkName");
    expect(result.sketch).toContain("result:");
    expect(typeof (result as Extract<typeof result, { ok: true }>).truncatedAt).toBe("number");
  });

  test("returns ok=false when body is not JSON at all", () => {
    const result = buildJsonSketch("<html><body>hi</body></html>");
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("none");
  });
});

describe("buildHtmlPreview", () => {
  test("strips script, style, svg, nav, header, footer tags", () => {
    const html = `
      <html>
        <head><script>evil()</script><style>.x{}</style></head>
        <body>
          <nav>Home</nav>
          <header>Header</header>
          <svg><path/></svg>
          <main>Real content here</main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const result = buildHtmlPreview(html);
    expect(result).not.toContain("evil()");
    expect(result).not.toContain(".x{}");
    expect(result).not.toContain("Home");
    expect(result).not.toContain("<path");
    expect(result).toContain("Real content here");
  });

  test("caps output at first 2K + last 2K chars", () => {
    const html = `<main>${"a".repeat(10_000)}</main>`;
    const result = buildHtmlPreview(html);
    expect(result.length).toBeLessThanOrEqual(4200); // 2K + 2K + separator
  });

  test("returns full content when under cap", () => {
    const html = "<main>short</main>";
    const result = buildHtmlPreview(html);
    expect(result).toContain("short");
  });
});

describe("buildPreview", () => {
  test("routes to JSON path when body parses as JSON", () => {
    const body = JSON.stringify({ foo: "bar" });
    const result = buildPreview({
      body,
      sourceUrl: "https://x.test",
      fetchUrl: "https://x.test/feed.json",
    });
    expect(result.contentType).toBe("json");
    expect(result.sketch).toContain("foo: string");
    expect(result.queryJsonAvailable).toBe(true);
  });

  test("routes to HTML path when body is not JSON", () => {
    const body = "<html><body><main>hello</main></body></html>";
    const result = buildPreview({ body, sourceUrl: "https://x.test", fetchUrl: "https://x.test/" });
    expect(result.contentType).toBe("html");
    expect(result.sketch).toContain("hello");
    expect(result.queryJsonAvailable).toBe(false);
  });

  test("reports partial mode when JSON is truncated", () => {
    const body = '{"a":1,"b":[1,2,3';
    const result = buildPreview({
      body,
      sourceUrl: "https://x.test",
      fetchUrl: "https://x.test/feed.json",
    });
    expect(result.contentType).toBe("json");
    expect(result.mode).toBe("toolloop:partial");
  });

  test("reports no_sketch mode when nothing can be parsed", () => {
    // A totally malformed, not-HTML body — JSON parse fails, HTML preview
    // passes through unchanged, and the looksUnusable heuristic fires.
    const body = "<<<<>>>>";
    const result = buildPreview({ body, sourceUrl: "https://x.test", fetchUrl: "https://x.test/" });
    expect(result.mode).toBe("toolloop:no_sketch");
  });
});
