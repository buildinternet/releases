import { beforeEach, describe, expect, it } from "bun:test";
import { createAuth, resetAuthCacheForTests } from "../src/auth/index.js";
import {
  classifyAuthApiError,
  classifyAuthRedirectFailure,
  rewriteBrowserAuthServerError,
} from "../src/auth/auth-error.js";
import type { AuthAuditFields } from "../src/auth/audit.js";

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
  WEB_BASE_URL: "https://releases.localhost",
} as never;

describe("classifyAuthRedirectFailure", () => {
  it("logs the OAuth callback code and provider, not the description", () => {
    const fields = classifyAuthRedirectFailure({
      path: "/api/auth/callback/google",
      method: "GET",
      status: 302,
      location:
        "https://releases.sh/auth/error?error=state_mismatch&error_description=ada@example.com",
    });
    expect(fields).toEqual({
      event: "auth-redirect-error",
      code: "state_mismatch",
      provider: "google",
    });
    expect(JSON.stringify(fields)).not.toContain("ada@example.com");
    expect(JSON.stringify(fields)).not.toContain("error_description");
  });

  it("logs magic-link and authorize failures without a provider", () => {
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/magic-link/verify",
        method: "GET",
        status: 302,
        location: "https://releases.sh/auth/error?error=INVALID_TOKEN",
      }),
    ).toEqual({ event: "auth-redirect-error", code: "INVALID_TOKEN" });
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/oauth2/authorize",
        method: "GET",
        status: 302,
        location: "https://releases.sh/auth/error?error=invalid_redirect",
      })?.code,
    ).toBe("invalid_redirect");
  });

  it("replaces an unsafe error query with unknown", () => {
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/verify-email",
        method: "GET",
        status: 302,
        location: "https://releases.sh/auth/continue?next=%2F&error=ada@example.com",
      })?.code,
    ).toBe("unknown");
  });

  it("skips the callback POST hop and successful redirects", () => {
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/callback/google",
        method: "POST",
        status: 302,
        location: "https://api.releases.sh/api/auth/callback/google?error=access_denied&state=x",
      }),
    ).toBeNull();
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/callback/google",
        method: "GET",
        status: 302,
        location: "https://releases.sh/following",
      }),
    ).toBeNull();
    expect(
      classifyAuthRedirectFailure({
        path: "/api/auth/get-session",
        method: "GET",
        status: 302,
        location: "https://releases.sh/auth/error?error=state_mismatch",
      }),
    ).toBeNull();
  });
});

describe("classifyAuthApiError", () => {
  it("keeps credential failures on the existing sign-in-failure event", () => {
    expect(
      classifyAuthApiError({
        status: "UNAUTHORIZED",
        body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "ada@example.com" },
      }),
    ).toBeNull();
    expect(
      classifyAuthApiError({ status: "TOO_MANY_REQUESTS", body: { code: "RATE_LIMIT" } }),
    ).toBeNull();
  });

  it("logs an otherwise unhandled code and drops the message", () => {
    const fields = classifyAuthApiError({
      status: "INTERNAL_SERVER_ERROR",
      body: { code: "unable_to_create_user", message: "failed for ada@example.com" },
    });
    expect(fields).toEqual({ event: "auth-api-error", code: "unable_to_create_user" });
    expect(JSON.stringify(fields)).not.toContain("ada@example.com");
  });

  it("does not log a code that is not a token", () => {
    expect(
      classifyAuthApiError({ status: "BAD_REQUEST", body: { code: "ada@example.com" } }),
    ).toEqual({ event: "auth-api-error", code: "unknown" });
  });

  it("falls back to the status when the throw has no code", () => {
    expect(
      classifyAuthApiError({ status: "BAD_REQUEST", body: { message: "invalid id token" } }),
    ).toEqual({
      event: "auth-api-error",
      code: "BAD_REQUEST",
    });
  });
});

describe("rewriteBrowserAuthServerError", () => {
  it("sends a callback 500 to the web error page with the body's code", async () => {
    const res = new Response(
      JSON.stringify({ code: "unable_to_create_user", message: "ada@example.com" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
    const rewritten = await rewriteBrowserAuthServerError(
      "https://api.releases.sh/api/auth/callback/google",
      "GET",
      res,
      "https://releases.sh/auth/error",
    );
    expect(rewritten?.status).toBe(302);
    expect(rewritten?.headers.get("location")).toBe(
      "https://releases.sh/auth/error?error=unable_to_create_user",
    );
  });

  it("uses a generic code when the 500 body is empty", async () => {
    const rewritten = await rewriteBrowserAuthServerError(
      "https://api.releases.sh/api/auth/magic-link/verify",
      "GET",
      new Response(null, { status: 500 }),
      "https://releases.sh/auth/error",
    );
    expect(rewritten?.headers.get("location")).toBe(
      "https://releases.sh/auth/error?error=internal_server_error",
    );
  });

  it("leaves session reads and handled redirects alone", async () => {
    expect(
      await rewriteBrowserAuthServerError(
        "https://api.releases.sh/api/auth/get-session",
        "GET",
        new Response(null, { status: 500 }),
        "https://releases.sh/auth/error",
      ),
    ).toBeNull();
    expect(
      await rewriteBrowserAuthServerError(
        "https://api.releases.sh/api/auth/callback/google",
        "GET",
        new Response(null, {
          status: 302,
          headers: { Location: "https://releases.sh/auth/error?error=state_mismatch" },
        }),
        "https://releases.sh/auth/error",
      ),
    ).toBeNull();
  });
});

describe("onAPIError.onError", () => {
  beforeEach(() => resetAuthCacheForTests());

  it("records an unhandled code and ignores a credential failure", async () => {
    const events: Array<{ level: "info" | "warn"; fields: AuthAuditFields }> = [];
    const auth = await createAuth(testEnv, undefined, {
      sendEmail: () => {},
      audit: (level, fields) => {
        events.push({ level, fields });
      },
    });
    const onError = auth.options.onAPIError?.onError;
    expect(onError).toBeFunction();
    await onError?.({
      status: "INTERNAL_SERVER_ERROR",
      body: { code: "unable_to_create_user", message: "ada@example.com" },
    });
    await onError?.({
      status: "UNAUTHORIZED",
      body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "nope" },
    });
    expect(events).toEqual([
      { level: "warn", fields: { event: "auth-api-error", code: "unable_to_create_user" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("ada@example.com");
  });
});
