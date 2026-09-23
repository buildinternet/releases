import { describe, expect, it } from "bun:test";
import {
  anonymousIdempotencyPrincipal,
  authenticatedIdempotencyPrincipal,
  userIdempotencyPrincipal,
} from "../src/lib/idempotency-principal.js";
import type { AuthContext } from "../src/middleware/auth.js";

describe("idempotency principals", () => {
  it("keeps user and anonymous routes in their explicit namespaces", () => {
    expect(userIdempotencyPrincipal("user_42")).toEqual({ namespace: "user", id: "user_42" });
    expect(anonymousIdempotencyPrincipal()).toEqual({ namespace: "anonymous", id: "anonymous" });
  });

  it("uses distinct authenticated namespaces for root, tokens, and OAuth clients", () => {
    const root = { kind: "root", scopes: ["admin"] } satisfies AuthContext;
    const token = { kind: "token", tokenId: "tok_42", scopes: ["admin"] } satisfies AuthContext;
    const oauth = {
      kind: "token",
      tokenId: "oauth_m2m",
      scopes: ["admin"],
      oauthClientId: "client_42",
    } satisfies AuthContext;

    expect(authenticatedIdempotencyPrincipal({ auth: root })).toEqual({
      namespace: "root",
      id: "root",
    });
    expect(authenticatedIdempotencyPrincipal({ auth: token })).toEqual({
      namespace: "token",
      id: "tok_42",
    });
    expect(authenticatedIdempotencyPrincipal({ auth: oauth })).toEqual({
      namespace: "oauth-client",
      id: "client_42",
    });
  });

  it("refuses a subjectless OAuth token without a verified client identity", () => {
    const subjectlessOauth = {
      kind: "token",
      tokenId: "oauth_m2m",
      scopes: ["admin"],
    } satisfies AuthContext;

    expect(authenticatedIdempotencyPrincipal({ auth: subjectlessOauth })).toBeNull();
  });

  it("accepts the no-secret local skip only when ENVIRONMENT is absent", () => {
    expect(authenticatedIdempotencyPrincipal({ localAuthSkip: true })).toEqual({
      namespace: "local-root",
      id: "local-root",
    });
    expect(
      authenticatedIdempotencyPrincipal({ localAuthSkip: true, environment: "production" }),
    ).toBeNull();
    expect(
      authenticatedIdempotencyPrincipal({ localAuthSkip: true, environment: "staging" }),
    ).toBeNull();
    expect(
      authenticatedIdempotencyPrincipal({ localAuthSkip: true, environment: "development" }),
    ).toBeNull();
  });

  it("does not invent a principal for an unauthenticated request", () => {
    expect(authenticatedIdempotencyPrincipal({})).toBeNull();
  });
});
