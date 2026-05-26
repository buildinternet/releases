/**
 * Web Bot Auth public key material + directory builder. Pure, non-secret,
 * runtime-neutral. The PRIVATE key lives only in Cloudflare Secrets Store
 * (WEB_BOT_AUTH_PRIVATE_KEY); never put it here.
 *
 * `WEB_BOT_AUTH_PUBLIC_JWK` below is provisioned — the directory route serves
 * it as a JWKS. To rotate: run `bun scripts/gen-web-bot-auth-key.ts`, overwrite
 * `x`/`kid` with the printed public key, and store the matching private JWK in
 * Secrets Store. If `x`/`kid` are ever blank, `isWebBotAuthProvisioned()` is
 * false and the directory route 404s. Publishing a key here does not by itself
 * sign anything — outbound signing is separately gated by `WEB_BOT_AUTH_ENABLED`
 * on the workers.
 */
export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** base64url-encoded 32-byte public key. */
  x: string;
  /** RFC 7638 JWK thumbprint; doubles as the Signature-Input `keyid`. */
  kid: string;
}

/** Provisioned public key. Regenerate via scripts/gen-web-bot-auth-key.ts; blank x/kid = not provisioned. */
export const WEB_BOT_AUTH_PUBLIC_JWK: Ed25519PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "T3xQIUh8YDXrRIpcuv7JwTssiG2SmZm88xefZ9p73PA",
  kid: "xm9vX_JGaIyVnz-jiWYFQlgy9UiafzNQLGzxYYI6wO4",
};

/**
 * Canonical crawler User-Agent shown to third-party sites. Single source of
 * truth: `@releases/adapters` re-exports this as `RELEASES_BOT_UA`, and the
 * public /bot page renders it.
 */
export const WEB_BOT_AUTH_USER_AGENT = "releases/0.1 (+https://releases.sh)";

/** Identity host. The Signature-Agent header sends this as a quoted sf-string. */
export const WEB_BOT_AUTH_SIGNATURE_AGENT = "https://releases.sh";

/** Where the directory is published (and what the form's validation URL is). */
export const WEB_BOT_AUTH_DIRECTORY_URL =
  "https://releases.sh/.well-known/http-message-signatures-directory";

/** RFC 9421 signature `tag` Cloudflare requires for verified bots. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

export const WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE =
  "application/http-message-signatures-directory+json";

/** True once a real public key has been provisioned. */
export function isWebBotAuthProvisioned(jwk: Ed25519PublicJwk = WEB_BOT_AUTH_PUBLIC_JWK): boolean {
  return jwk.x.length > 0 && jwk.kid.length > 0;
}

/** Build the `.well-known/http-message-signatures-directory` JWKS response body. */
export function buildSignaturesDirectory(jwk: Ed25519PublicJwk = WEB_BOT_AUTH_PUBLIC_JWK): {
  body: string;
  contentType: string;
} {
  return {
    body: JSON.stringify({ keys: [jwk] }),
    contentType: WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE,
  };
}
