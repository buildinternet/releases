import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { parseJsonBody, readJsonBodyCapped } from "./json-body.js";
import { respondError } from "./error-response.js";

// A POST Request whose body is a ReadableStream — no Content-Length header, the
// chunked shape that slips past a header-only size check.
function streamedRequest(chunks: Uint8Array[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://x/", {
    method: "POST",
    body: stream,
    // Required by undici/Bun when the body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function app() {
  const a = new Hono();
  a.onError((err, c) => respondError(c, err));
  a.post("/parse", async (c) => {
    const body = await parseJsonBody<{ value?: unknown }>(c);
    return c.json({ ok: true, body });
  });
  return a;
}

describe("parseJsonBody", () => {
  it("returns {} for an absent body", async () => {
    const res = await app().request("https://x.test/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; body: Record<string, never> }).toEqual({
      ok: true,
      body: {},
    });
  });

  it("parses valid JSON", async () => {
    const res = await app().request("https://x.test/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; body: { value: number } }).toEqual({
      ok: true,
      body: { value: 1 },
    });
  });

  it("400s malformed JSON with 'invalid JSON body'", async () => {
    const res = await app().request("https://x.test/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.type).toBe("validation");
    expect(body.error.message).toBe("invalid JSON body");
  });
});

describe("readJsonBodyCapped", () => {
  const MAX = 64 * 1024;

  it("parses a valid streamed JSON body", async () => {
    const result = await readJsonBodyCapped(streamedRequest([encode('{"value":1}')]), MAX);
    expect(result).toEqual({ ok: true, value: { value: 1 } });
  });

  it("enforces the cap on a chunked body with no Content-Length header", async () => {
    // Split an oversized payload across several chunks — the header-only guard
    // never sees a length, so only the streaming accumulator can reject this.
    const chunk = encode("x".repeat(16 * 1024));
    const result = await readJsonBodyCapped(
      streamedRequest([chunk, chunk, chunk, chunk, chunk]),
      MAX,
    );
    expect(result).toEqual({ ok: false, status: 413, error: "payload_too_large" });
  });

  it("bails as soon as the running total exceeds the cap (does not buffer the rest)", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        // Each pull emits a chunk half the cap; the third pull crosses it.
        controller.enqueue(encode("y".repeat(MAX / 2 + 1)));
      },
    });
    const req = new Request("http://x/", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJsonBodyCapped(req, MAX);
    expect(result).toEqual({ ok: false, status: 413, error: "payload_too_large" });
    // Cancelled after the second chunk crossed the cap — never drained further.
    expect(pulled).toBe(2);
  });

  it("400s an unparseable streamed body", async () => {
    const result = await readJsonBodyCapped(streamedRequest([encode("{not json")]), MAX);
    expect(result).toEqual({ ok: false, status: 400, error: "invalid_json" });
  });

  it("400s an absent body", async () => {
    const req = new Request("http://x/", { method: "POST" });
    const result = await readJsonBodyCapped(req, MAX);
    expect(result).toEqual({ ok: false, status: 400, error: "invalid_json" });
  });

  it("accepts a body exactly at the cap", async () => {
    // Pad a valid JSON string to exactly MAX bytes so byteLength === MAX (not >).
    const pad = " ".repeat(MAX - 2);
    const body = `${pad}{}`; // JSON tolerates leading whitespace
    expect(encode(body).byteLength).toBe(MAX);
    const result = await readJsonBodyCapped(streamedRequest([encode(body)]), MAX);
    expect(result).toEqual({ ok: true, value: {} });
  });
});
