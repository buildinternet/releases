import { jwkThumbprint, signDirectoryResponse } from "@releases/core-internal/web-bot-auth-sign";
import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  buildSignaturesDirectory,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";

// Signatures expire minutes after they're made, so this can never be cached.
export const dynamic = "force-dynamic";

/**
 * Sign the directory for `authority` with the private JWK in `rawKey`, or
 * return null when the key is absent, malformed, or not the published key (a
 * signature from an unpublished key could never verify).
 */
async function directorySignature(
  rawKey: string | undefined,
  authority: string,
): Promise<{ Signature: string; "Signature-Input": string } | null> {
  if (!rawKey) return null;
  try {
    const privateJwk = JSON.parse(rawKey) as JsonWebKey;
    const keyId = await jwkThumbprint(privateJwk);
    if (keyId !== WEB_BOT_AUTH_PUBLIC_JWK.kid) {
      console.warn(
        `web-bot-auth: WEB_BOT_AUTH_PRIVATE_KEY (${keyId}) is not the published key (${WEB_BOT_AUTH_PUBLIC_JWK.kid}); serving unsigned directory`,
      );
      return null;
    }
    return await signDirectoryResponse({ privateJwk, keyId, authority });
  } catch (err) {
    console.warn("web-bot-auth: directory signing failed; serving unsigned directory", err);
    return null;
  }
}

/**
 * Publishes our Ed25519 public key(s) for Web Bot Auth request verification.
 *
 * Cloudflare's bot registration also requires the response itself to be signed
 * by each published key, over `"@authority";req` (the Host it was fetched on),
 * so a mirror can't register our key as its own. The private key comes from
 * the `WEB_BOT_AUTH_PRIVATE_KEY` env var (production only, same JWK as the
 * workers' Secrets Store copy). Without it the JWKS is served unsigned.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isWebBotAuthProvisioned()) {
    return new Response("Web Bot Auth key not provisioned", { status: 404 });
  }
  const { body, contentType } = buildSignaturesDirectory(WEB_BOT_AUTH_PUBLIC_JWK);
  const headers = new Headers({ "Content-Type": contentType, "Cache-Control": "no-store" });
  const authority = req.headers.get("host") ?? new URL(req.url).host;
  const sig = await directorySignature(process.env.WEB_BOT_AUTH_PRIVATE_KEY, authority);
  if (sig) {
    headers.set("Signature", sig.Signature);
    headers.set("Signature-Input", sig["Signature-Input"]);
  }
  return new Response(body, { headers });
}
