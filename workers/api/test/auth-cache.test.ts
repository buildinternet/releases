import { beforeEach, describe, expect, it } from "bun:test";
import { createAuth, resetAuthCacheForTests } from "../src/auth/index.js";

const testEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET_DEV: "test-secret-do-not-use-in-prod-0123456789",
  ENVIRONMENT: "development",
} as never;

describe("createAuth memoization", () => {
  beforeEach(() => resetAuthCacheForTests());

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
});
