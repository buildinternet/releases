import { afterEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubUpstream(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function post(body: unknown = { url: "https://example.com/releases", type: "source" }) {
  return new NextRequest("https://releases.sh/api/recommendations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/recommendations proxy", () => {
  it("flattens the worker's nested error envelope to { error: <code> }", async () => {
    // The worker now emits the standardized nested envelope; the form reads a
    // flat string, so the proxy must surface the code, not the object.
    stubUpstream(400, {
      error: { code: "bad_request", type: "validation", message: "Provide a valid http(s) URL." },
    });
    const res = await POST(post());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("maps a rate-limited envelope to the flat rate_limited code", async () => {
    stubUpstream(429, {
      error: { code: "rate_limited", type: "rate_limited", message: "Too many requests." },
    });
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("falls back to upstream_error when the error shape is unexpected", async () => {
    stubUpstream(500, { nope: true });
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "upstream_error" });
  });

  it("tolerates a legacy flat { error: string } upstream body", async () => {
    stubUpstream(400, { error: "invalid_json" });
    const res = await POST(post());
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("passes a successful response through verbatim", async () => {
    stubUpstream(202, { ok: true, id: "rec_abc123" });
    const res = await POST(post());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, id: "rec_abc123" });
  });

  it("400s an unparseable request body without calling upstream", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    const req = new NextRequest("https://releases.sh/api/recommendations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(called).toBe(false);
  });
});
