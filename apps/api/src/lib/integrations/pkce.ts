/**
 * OAuth 2.1 PKCE (S256). Verifier is 32 random bytes, base64url-encoded
 * (43 chars) — within the 43–128 unreserved-character window.
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateOAuthState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}
