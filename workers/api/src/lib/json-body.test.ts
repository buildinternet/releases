import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseJsonBody } from "./json-body.js";

function app() {
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(
        { error: status === 400 ? "bad_request" : "http_error", message: err.message },
        status,
      );
    }
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });
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
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("bad_request");
    expect(json.message).toBe("invalid JSON body");
  });
});
