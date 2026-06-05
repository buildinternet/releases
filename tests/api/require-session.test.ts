import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import { requireSession } from "../../workers/api/src/middleware/auth.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function env(extra: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://api.releases.localhost",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    ...extra, // spread last so callers can override (e.g. flip the flag off)
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

function app() {
  const a = new Hono<Env>();
  a.use("/probe", requireSession);
  a.get("/probe", (c) => c.json({ userId: c.get("session")?.user.id ?? null }));
  return a;
}

/** Sign up + verify + sign in; return the session cookie header value. */
async function authedCookie(): Promise<string> {
  const auth = await createAuth(env(), undefined, { db: h!.db });
  await auth.api.signUpEmail({
    body: { email: "ann@example.com", password: "correct-horse-battery", name: "Ann" },
  });
  h!.db.update(user).set({ emailVerified: true }).where(eq(user.email, "ann@example.com")).run();
  const res = await auth.api.signInEmail({
    body: { email: "ann@example.com", password: "correct-horse-battery" },
    asResponse: true,
  });
  const cookies = res.headers.getSetCookie();
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe("requireSession", () => {
  it("404 when the user-api-keys flag is off", async () => {
    h = createTestDb();
    const res = await app().request("/probe", {}, env({ USER_API_KEYS_ENABLED: "false" }));
    expect(res.status).toBe(404);
  });

  it("401 when there is no session cookie", async () => {
    h = createTestDb();
    const res = await app().request("/probe", {}, env());
    expect(res.status).toBe(401);
  });

  it("passes and exposes the session user id with a valid cookie", async () => {
    h = createTestDb();
    const cookie = await authedCookie();
    const res = await app().request("/probe", { headers: { Cookie: cookie } }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(typeof body.userId).toBe("string");
  });
});
