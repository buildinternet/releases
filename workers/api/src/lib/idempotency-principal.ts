import type { AuthContext } from "../middleware/auth.js";

export type IdempotencyPrincipal =
  | { namespace: "user"; id: string }
  | { namespace: "token"; id: string }
  | { namespace: "root"; id: "root" }
  | { namespace: "oauth-client"; id: string }
  | { namespace: "local-root"; id: "local-root" }
  | { namespace: "anonymous"; id: "anonymous" };

export function userIdempotencyPrincipal(userId: string): IdempotencyPrincipal {
  return { namespace: "user", id: userId };
}

export function anonymousIdempotencyPrincipal(): IdempotencyPrincipal {
  return { namespace: "anonymous", id: "anonymous" };
}

export function authenticatedIdempotencyPrincipal(input: {
  auth?: AuthContext;
  localAuthSkip?: boolean;
  environment?: string;
}): IdempotencyPrincipal | null {
  if (input.auth?.kind === "root") return { namespace: "root", id: "root" };
  if (input.auth?.kind === "token") {
    if (input.auth.tokenId === "oauth_m2m") {
      return input.auth.oauthClientId
        ? { namespace: "oauth-client", id: input.auth.oauthClientId }
        : null;
    }
    return { namespace: "token", id: input.auth.tokenId };
  }
  if (input.localAuthSkip && input.environment === undefined) {
    return { namespace: "local-root", id: "local-root" };
  }
  return null;
}
