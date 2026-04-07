import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

const { wantsMarkdown, markdownResponse, varyOnAccept } = (await import(
  "../../workers/api/src/middleware/content-negotiation.js"
)) as any;

// ---------------------------------------------------------------------------
// wantsMarkdown
// ---------------------------------------------------------------------------

describe("wantsMarkdown", () => {
  function mockContext(accept?: string) {
    return {
      req: {
        header: (name: string) => (name === "accept" ? accept : undefined),
      },
    };
  }

  it("returns true when Accept is text/markdown", () => {
    expect(wantsMarkdown(mockContext("text/markdown"))).toBe(true);
  });

  it("returns true when text/markdown appears before application/json", () => {
    expect(wantsMarkdown(mockContext("text/markdown, application/json"))).toBe(true);
  });

  it("returns false when application/json appears before text/markdown", () => {
    expect(wantsMarkdown(mockContext("application/json, text/markdown"))).toBe(false);
  });

  it("returns false when Accept does not include text/markdown", () => {
    expect(wantsMarkdown(mockContext("application/json"))).toBe(false);
  });

  it("returns false when Accept header is missing", () => {
    expect(wantsMarkdown(mockContext(undefined))).toBe(false);
  });

  it("returns false for empty Accept header", () => {
    expect(wantsMarkdown(mockContext(""))).toBe(false);
  });

  it("returns true when text/markdown is present and json is absent", () => {
    expect(wantsMarkdown(mockContext("text/markdown, text/html"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markdownResponse
// ---------------------------------------------------------------------------

describe("markdownResponse", () => {
  it("returns a Response with text/markdown content type", async () => {
    const app = new Hono();
    app.get("/test", (c) => markdownResponse(c, "# Hello"));
    const res = await app.request("/test");
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# Hello");
  });

  it("includes x-markdown-tokens header", async () => {
    const app = new Hono();
    app.get("/test", (c) => markdownResponse(c, "Hello world"));
    const res = await app.request("/test");
    const tokens = res.headers.get("x-markdown-tokens");
    expect(tokens).toBeDefined();
    expect(parseInt(tokens!, 10)).toBeGreaterThan(0);
  });

  it("does not set Vary header (middleware handles it)", async () => {
    const app = new Hono();
    app.get("/test", (c) => markdownResponse(c, "# Hello"));
    const res = await app.request("/test");
    // Vary: Accept is set by the varyOnAccept middleware, not markdownResponse
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("estimates tokens as roughly content length / 4", async () => {
    const body = "a".repeat(400);
    const app = new Hono();
    app.get("/test", (c) => markdownResponse(c, body));
    const res = await app.request("/test");
    const tokens = parseInt(res.headers.get("x-markdown-tokens")!, 10);
    expect(tokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// varyOnAccept middleware
// ---------------------------------------------------------------------------

describe("varyOnAccept", () => {
  it("adds Vary: Accept to GET responses", async () => {
    const app = new Hono();
    app.use("*", varyOnAccept());
    app.get("/test", (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "GET" });
    expect(res.headers.get("Vary")).toContain("Accept");
  });

  it("does NOT add Vary header to non-GET responses", async () => {
    const app = new Hono();
    app.use("*", varyOnAccept());
    app.post("/test", (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "POST" });
    expect(res.headers.get("Vary")).toBeNull();
  });
});
