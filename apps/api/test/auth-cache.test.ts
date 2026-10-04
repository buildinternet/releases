import { beforeEach, describe, expect, it } from "bun:test";
import { createAuth, resetAuthCacheForTests } from "../src/auth/index.js";

/**
 * Minimal D1 stand-in. Better Auth 1.7's oauth-provider seeds the
 * `oauth_resource` rows at plugin init, so constructing the auth instance now
 * touches the DB binding — a bare `{}` makes the drizzle adapter throw. Every
 * statement resolves to an empty result set, which is all the seed needs
 * (it inserts, and the insert is a no-op against this stub).
 */
function fakeD1() {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [], success: true, meta: {} }),
    first: async () => null,
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
  };
  return { prepare: () => stmt, batch: async () => [], dump: async () => new ArrayBuffer(0) };
}

const testEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET_DEV: "test-secret-do-not-use-in-prod-0123456789",
  ENVIRONMENT: "development",
  DB: fakeD1(),
} as never;

describe("createAuth memoization", () => {
  beforeEach(() => resetAuthCacheForTests());

  it("points OAuth failures at the web error page and encrypts the session cache", async () => {
    const auth = await createAuth({
      ...(testEnv as Record<string, unknown>),
      WEB_BASE_URL: "https://releases.localhost/",
    } as never);
    expect(auth.options.onAPIError?.errorURL).toBe("https://releases.localhost/auth/error");
    expect(auth.options.session?.cookieCache).toMatchObject({
      enabled: true,
      maxAge: 5 * 60,
      strategy: "jwe",
    });
  });

  it("reuses the same instance for repeated calls with the same env", async () => {
    const first = await createAuth(testEnv);
    const second = await createAuth(testEnv);
    expect(second).toBe(first);
  });

  it("builds separate instances when ENVIRONMENT differs", async () => {
    const dev = await createAuth(testEnv);
    const prod = await createAuth({
      ...(testEnv as Record<string, unknown>),
      ENVIRONMENT: "production",
    } as never);
    expect(prod).not.toBe(dev);
  });

  it("bypasses the cache when test deps are injected", async () => {
    const first = await createAuth(testEnv, undefined, { sendEmail: () => {} });
    const second = await createAuth(testEnv, undefined, { sendEmail: () => {} });
    expect(second).not.toBe(first);
  });

  it("builds separate instances when the DB binding object changes", async () => {
    const base = testEnv as Record<string, unknown>;
    const first = await createAuth({ ...base, DB: fakeD1() } as never);
    const second = await createAuth({ ...base, DB: fakeD1() } as never);
    expect(second).not.toBe(first);
  });
});
