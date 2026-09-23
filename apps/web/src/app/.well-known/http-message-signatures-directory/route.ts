import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  buildSignaturesDirectory,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";

export const dynamic = "force-static";
export const revalidate = false;

/** Publishes our Ed25519 public key(s) for Web Bot Auth request verification. */
export function GET(): Response {
  if (!isWebBotAuthProvisioned()) {
    return new Response("Web Bot Auth key not provisioned", { status: 404 });
  }
  const { body, contentType } = buildSignaturesDirectory(WEB_BOT_AUTH_PUBLIC_JWK);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
