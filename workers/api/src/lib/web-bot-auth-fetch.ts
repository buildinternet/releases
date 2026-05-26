import { jwkThumbprint, signingFetchFromRawKey } from "@releases/core-internal/web-bot-auth-sign";
import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";

export interface WebBotAuthEnv {
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
}

/**
 * Build the outbound fetch the crawler should use for third-party content.
 * Returns global `fetch` unless signing is enabled AND a private key is bound.
 * The signing keyId is the RFC 7638 thumbprint derived from the private key
 * (so it always identifies the key that produced the signature). When the
 * committed public key is also provisioned, a mismatch is logged so operators
 * notice a Secrets-Store / directory key disagreement. Fail-open: any error
 * returns global `fetch`.
 */
export async function makeBotFetch(env: WebBotAuthEnv): Promise<typeof fetch> {
  if (env.WEB_BOT_AUTH_ENABLED !== "true") return fetch;
  try {
    const raw = await getSecret(env.WEB_BOT_AUTH_PRIVATE_KEY);
    if (!raw) {
      logEvent("warn", { component: "web-bot-auth", event: "key-missing" });
      return fetch;
    }
    // Operator-facing sanity check: warn when the key that will sign doesn't
    // match the public key published in the directory. Only meaningful once a
    // public key is committed; skipped otherwise.
    if (isWebBotAuthProvisioned()) {
      const keyId = await jwkThumbprint(JSON.parse(raw) as JsonWebKey);
      if (keyId !== WEB_BOT_AUTH_PUBLIC_JWK.kid) {
        logEvent("warn", {
          component: "web-bot-auth",
          event: "keyid-mismatch",
          derived: keyId,
          published: WEB_BOT_AUTH_PUBLIC_JWK.kid,
        });
      }
    }
    return await signingFetchFromRawKey(raw);
  } catch (err) {
    logEvent("warn", { component: "web-bot-auth", event: "sign-setup-failed", err });
    return fetch;
  }
}
