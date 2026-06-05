import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { userApiKeyHandlers } from "./user-api-keys.js";
import type { Env } from "../index.js";

// Mount the auth-free handlers behind an injected session, mirroring the
// production composition's `requireSession` (which sets `c.get("session")`).
// The scope-ceiling check runs before `createAuth`/D1 is ever touched, so the
// rejection path needs no database — only a session and a JSON body.
function appWithSession() {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("session", { user: { id: "user_1", email: "a@example.com", name: "A" } });
    await next();
  });
  app.route("/", userApiKeyHandlers);
  return app;
}

function postKey(body: unknown) {
  return appWithSession().fetch(
    new Request("https://api.releases.sh/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {} as never,
  );
}

describe("POST /api-keys scope ceiling (user keys are read-only)", () => {
  it("rejects a 'write' scope request with 400", async () => {
    const res = await postKey({ name: "k", scope: "write" });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: string; message?: string };
    expect(j.error).toBe("bad_request");
    expect(j.message ?? "").toMatch(/read/i);
  });

  it("rejects an 'admin' scope request with 400", async () => {
    const res = await postKey({ name: "k", scope: "admin" });
    expect(res.status).toBe(400);
  });
});
