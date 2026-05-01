import { describe, it, expect, mock } from "bun:test";

mock.module("@releases/ai-internal/evaluate", () => ({
  evaluateChangelog: async () => ({ recommendation: "ingest", provider: null }),
}));

const { Hono } = await import("hono");
const { evaluateRoutes } = await import("../src/routes/evaluate.js");

function mkApp() {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", evaluateRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, {});
}

describe("GET /v1/evaluate", () => {
  it("returns 400 when url param is missing", async () => {
    const fetch = mkApp();
    const res = await fetch(new Request("https://x.test/v1/evaluate"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_parameter");
  });

  it("returns 400 for a non-URL string", async () => {
    const fetch = mkApp();
    const res = await fetch(new Request("https://x.test/v1/evaluate?url=not-a-url"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_parameter");
  });

  it("returns 400 for an http: URL", async () => {
    const fetch = mkApp();
    const res = await fetch(
      new Request("https://x.test/v1/evaluate?url=" + encodeURIComponent("http://example.com")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("URL must use https");
  });

  it("returns 400 for an ftp: URL", async () => {
    const fetch = mkApp();
    const res = await fetch(
      new Request("https://x.test/v1/evaluate?url=" + encodeURIComponent("ftp://example.com/file")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns 400 for a file: URL", async () => {
    const fetch = mkApp();
    const res = await fetch(
      new Request("https://x.test/v1/evaluate?url=" + encodeURIComponent("file:///etc/passwd")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns 400 for a data: URL", async () => {
    const fetch = mkApp();
    const res = await fetch(
      new Request(
        "https://x.test/v1/evaluate?url=" + encodeURIComponent("data:text/plain;base64,SGVsbG8="),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns 200 for a valid https: URL", async () => {
    const fetch = mkApp();
    const res = await fetch(
      new Request(
        "https://x.test/v1/evaluate?url=" + encodeURIComponent("https://example.com/changelog"),
      ),
    );
    expect(res.status).toBe(200);
  });
});
