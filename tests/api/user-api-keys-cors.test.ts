import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  authCorsMiddleware,
  CREDENTIALED_CORS_MOUNT_PATHS,
  isCredentialedCorsPath,
} from "../../workers/api/src/auth/index.js";

// Mirrors the index.ts CORS wiring: authCorsMiddleware owns credentialed CORS on
// every CREDENTIALED_CORS_MOUNT_PATHS entry; the wildcard public cors() runs on
// every OTHER path (guarded by isCredentialedCorsPath). Without the carve-out the
// wildcard cors overwrites the credentialed Access-Control-Allow-Origin on the
// actual response — which a browser rejects for `credentials: "include"` requests
// (shows as "Failed to fetch" / CORS blocked).
function makeApp() {
  const app = new Hono();
  const credentialedCors = authCorsMiddleware();
  for (const path of CREDENTIALED_CORS_MOUNT_PATHS) {
    app.use(path, credentialedCors);
  }
  const publicReadCors = cors();
  app.use("*", (c, next) =>
    isCredentialedCorsPath(c.req.path) ? next() : publicReadCors(c, next),
  );
  app.get("/v1/api-keys", (c) => c.json({ apiKeys: [] }));
  app.post("/v1/me/avatar", (c) => c.json({ avatarUrl: "https://media.test/u.png" }));
  app.post("/v1/workspaces/:workspaceId/avatar", (c) =>
    c.json({ avatarUrl: "https://media.test/w.png" }),
  );
  app.post("/v1/listing/claim", (c) => c.json({ id: "clm_test" }));
  app.post("/v1/listing/claim/verify", (c) => c.json({ verified: true }));
  app.get("/v1/listing/claims", (c) => c.json({ claims: [] }));
  app.post("/v1/listing/promote", (c) => c.json({ promoted: true }));
  // Anonymous public-write listing routes stay on wildcard CORS.
  app.post("/v1/listing/validate", (c) => c.json({ ok: true }));
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  return app;
}

describe("session-authed credentialed CORS", () => {
  it("reflects the origin (not '*') with credentials on /v1/api-keys", async () => {
    const res = await makeApp().request(
      "/v1/api-keys",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("reflects the origin on /v1/workspaces/:id/avatar POSTs", async () => {
    const res = await makeApp().request(
      "/v1/workspaces/org_abc/avatar",
      {
        method: "POST",
        headers: { Origin: "https://releases.sh" },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allows multipart avatar upload preflights (content-type header)", async () => {
    const res = await makeApp().request(
      "/v1/workspaces/org_abc/avatar",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("allows the DELETE method on a /v1/api-keys/:id revoke preflight", async () => {
    const res = await makeApp().request(
      "/v1/api-keys/ak_1",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "DELETE",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("keeps wildcard CORS on other public routes", async () => {
    const res = await makeApp().request(
      "/v1/orgs",
      { headers: { Origin: "https://anything.example" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps wildcard CORS on anonymous listing validate (not session-authed)", async () => {
    const res = await makeApp().request(
      "/v1/listing/validate",
      {
        method: "POST",
        headers: { Origin: "https://anything.example" },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("reflects the origin with credentials on listing claim/claims/promote", async () => {
    const app = makeApp();
    for (const path of [
      "/v1/listing/claim",
      "/v1/listing/claim/verify",
      "/v1/listing/claims",
      "/v1/listing/promote",
    ]) {
      const res = await app.request(
        path,
        {
          method: path === "/v1/listing/claims" ? "GET" : "POST",
          headers: { Origin: "https://releases.sh" },
        },
        { ENVIRONMENT: "production" } as never,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("allows listing claim preflight with content-type (start claim body)", async () => {
    const res = await makeApp().request(
      "/v1/listing/claim",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("wildcard CORS on a mistaken double-/v1 path breaks credentialed uploads", async () => {
    const res = await makeApp().request(
      "/v1/v1/workspaces/org_abc/avatar",
      {
        method: "POST",
        headers: { Origin: "https://releases.sh" },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("isCredentialedCorsPath", () => {
  it("matches every session-authed browser surface", () => {
    expect(isCredentialedCorsPath("/api/auth/get-session")).toBe(true);
    expect(isCredentialedCorsPath("/v1/api-keys")).toBe(true);
    expect(isCredentialedCorsPath("/v1/api-keys/ak_1")).toBe(true);
    expect(isCredentialedCorsPath("/v1/me/follows")).toBe(true);
    expect(isCredentialedCorsPath("/v1/workspaces")).toBe(true);
    expect(isCredentialedCorsPath("/v1/workspaces/ws_1/avatar")).toBe(true);
    expect(isCredentialedCorsPath("/v1/listing/claim")).toBe(true);
    expect(isCredentialedCorsPath("/v1/listing/claim/verify")).toBe(true);
    expect(isCredentialedCorsPath("/v1/listing/claims")).toBe(true);
    expect(isCredentialedCorsPath("/v1/listing/promote")).toBe(true);
  });

  it("leaves anonymous public routes on wildcard", () => {
    expect(isCredentialedCorsPath("/v1/orgs")).toBe(false);
    expect(isCredentialedCorsPath("/v1/listing/validate")).toBe(false);
    expect(isCredentialedCorsPath("/v1/listing/activate")).toBe(false);
  });
});

/**
 * Drift gate: browser clients with `credentials: "include"` (or `meGet`) must
 * hit paths covered by CREDENTIALED_CORS_MOUNT_PATHS. Listing claim shipped
 * without the carve-out and failed in prod as CORS-blocked "Failed to fetch".
 *
 * Scans `web/src` for `apiBase()` / `meGet(...)` path templates. Same-origin
 * proxies and anonymous listing validate/activate are excluded.
 */
describe("browser credentialed clients stay on credentialed CORS", () => {
  it("every web credentials:include client path is covered by isCredentialedCorsPath", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === "__generated__") continue;
          yield* walk(p);
        } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.(ts|tsx)$/.test(ent.name)) {
          yield p;
        }
      }
    }

    // `${apiBase()}/v1/me/follows` | meGet("/v1/me/settings/…") | …}/v1/listing/claim
    const PATH_RE = /(?:apiBase\(\)\s*\}?|meGet\(\s*["'`])(\/(?:v1|api)\/[A-Za-z0-9_./${}`-]*)/g;
    const ANONYMOUS_API_PATHS = new Set(["/v1/listing/validate", "/v1/listing/activate"]);

    const uncovered: string[] = [];
    const seen = new Set<string>();

    for await (const file of walk(join(import.meta.dir, "../../web/src"))) {
      const src = await readFile(file, "utf8");
      // Only session-cookie clients — skip public apiBase() callers (listing validate).
      if (!/credentials:\s*["']include["']/.test(src) && !/\bmeGet\s*[<(]/.test(src)) continue;

      for (const m of src.matchAll(PATH_RE)) {
        const path = m[1]!
          .replace(/\$\{[^}]+\}/g, "_")
          .replace(/[`'"]/g, "")
          .split("?")[0]!
          .replace(/\/$/, "");
        if (!path || ANONYMOUS_API_PATHS.has(path)) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        if (!isCredentialedCorsPath(path)) {
          uncovered.push(`${path}  (from ${file.replace(/.*\/web\//, "web/")})`);
        }
      }
    }

    // If this is 0 the regex bit-rotted and the gate is useless.
    expect(seen.size).toBeGreaterThan(10);
    expect(uncovered).toEqual([]);
  });
});
