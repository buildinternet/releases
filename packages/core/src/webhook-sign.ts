// Web Crypto only — works in Workers, Bun, browsers. No node:crypto.

const enc = new TextEncoder();

async function importHmacKey(rawHex: string): Promise<CryptoKey> {
  const bytes = hexToBytes(rawHex);
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Derive a per-subscription signing key as hex.
 * key = HMAC-SHA256(master, "${subscriptionId}:${secretVersion}")
 *
 * `master` is hex-encoded (the value stored in Secrets Store should be 32+
 * bytes of `openssl rand -hex 32`). The output is a 64-char hex string
 * suitable as the input key for signPayload.
 */
export async function deriveSigningKey(
  masterHex: string,
  subscriptionId: string,
  secretVersion: number,
): Promise<string> {
  const key = await importHmacKey(masterHex);
  const data = enc.encode(`${subscriptionId}:${secretVersion}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return bytesToHex(sig);
}

/**
 * Sign the (timestamp, body) pair with the given hex key.
 * Returns "sha256=<hex>" suitable for the X-Released-Signature header.
 */
export async function signPayload(
  signingKeyHex: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  const key = await importHmacKey(signingKeyHex);
  const data = enc.encode(`${timestampSeconds}.${rawBody}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return `sha256=${bytesToHex(sig)}`;
}

/**
 * Constant-time verify against a candidate signature in "sha256=<hex>" form.
 * Returns false on any malformed input rather than throwing.
 */
export async function verifySignature(
  signingKeyHex: string,
  timestampSeconds: number,
  rawBody: string,
  candidate: string,
): Promise<boolean> {
  const expected = await signPayload(signingKeyHex, timestampSeconds, rawBody);
  return constantTimeEqual(expected, candidate);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
