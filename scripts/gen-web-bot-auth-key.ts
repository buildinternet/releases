#!/usr/bin/env bun
// scripts/gen-web-bot-auth-key.ts
// Generates an Ed25519 keypair for Web Bot Auth and prints:
//   1) PRIVATE JWK -> store in Cloudflare Secrets Store as WEB_BOT_AUTH_PRIVATE_KEY
//   2) PUBLIC JWK + RFC 7638 thumbprint -> paste into
//      packages/core/src/web-bot-auth.ts (WEB_BOT_AUTH_PUBLIC_JWK).
// Run: bun scripts/gen-web-bot-auth-key.ts
import { jwkThumbprint } from "@releases/core-internal/web-bot-auth-sign";

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;

const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
const kid = await jwkThumbprint(publicJwk);

console.log("\n=== PRIVATE KEY - store in Secrets Store as WEB_BOT_AUTH_PRIVATE_KEY ===");
console.log(JSON.stringify(privateJwk));

console.log("\n=== PUBLIC KEY - paste into packages/core/src/web-bot-auth.ts ===");
console.log(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid }, null, 2));
console.log(`\nkeyid (thumbprint): ${kid}\n`);
