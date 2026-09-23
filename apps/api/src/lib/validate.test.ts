import { expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { validateJson } from "./validate";

test("validateJson emits a nested validation envelope on schema failure", async () => {
  const app = new Hono();
  app.post("/x", validateJson(z.object({ n: z.number() })), (c) => c.json({ ok: true }));
  const res = await app.request("/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: "not-a-number" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string; type: string; message: string } };
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.type).toBe("validation");
  expect(typeof body.error.message).toBe("string");
});
