import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { parseJsonBody } from "./json-body.js";
import { respondError } from "./error-response.js";

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
