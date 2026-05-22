import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { authMiddleware, publicReadAuthMiddleware } from "../src/middleware/auth";

/** A fake Secrets Store binding — `getSecret` calls `.get()`. */
function secretBinding(value: string) {
  return { get: async () => value };
}

/** Minimal env carrying just the static-root secret binding. */
function envWithSecret(value: string) {
  return { RELEASES_API_KEY: secretBinding(value) } as never;
}

type ErrorBody = { error: string; message: string };

function adminApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware — missing vs invalid", () => {
  it("returns 401 'Missing API key' with a bare challenge when no Bearer is presented", async () => {
    const res = await adminApp().request("/", {}, envWithSecret("root-secret"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("unauthorized");
    expect(body.message).toBe("Missing API key");
    // RFC 6750: no token presented → challenge carries no error code.
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="releases-api"');
  });

  it("returns 401 'Invalid API key' with error=invalid_token when a wrong Bearer is presented", async () => {
    const res = await adminApp().request(
      "/",
      { headers: { Authorization: "Bearer wrong-secret" } },
      envWithSecret("root-secret"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("unauthorized");
    expect(body.message).toBe("Invalid API key");
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="releases-api", error="invalid_token"',
    );
  });

  it("passes a request carrying the correct static-root key", async () => {
    const res = await adminApp().request(
      "/",
      { headers: { Authorization: "Bearer root-secret" } },
      envWithSecret("root-secret"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("preserves open access when no secret is configured (local dev)", async () => {
    const res = await adminApp().request("/", {}, {} as never);
    expect(res.status).toBe(200);
  });
});

describe("publicReadAuthMiddleware — write methods distinguish missing vs invalid", () => {
  function publicApp() {
    const app = new Hono();
    app.use("*", publicReadAuthMiddleware);
    app.get("/", (c) => c.json({ ok: true }));
    app.post("/", (c) => c.json({ ok: true }));
    return app;
  }

  it("never rejects a GET (public read) even with no key", async () => {
    const res = await publicApp().request("/", {}, envWithSecret("root-secret"));
    expect(res.status).toBe(200);
  });

  it("rejects a POST with no key as 'Missing API key'", async () => {
    const res = await publicApp().request("/", { method: "POST" }, envWithSecret("root-secret"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.message).toBe("Missing API key");
  });

  it("rejects a POST with a wrong key as 'Invalid API key'", async () => {
    const res = await publicApp().request(
      "/",
      { method: "POST", headers: { Authorization: "Bearer nope" } },
      envWithSecret("root-secret"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.message).toBe("Invalid API key");
  });
});
