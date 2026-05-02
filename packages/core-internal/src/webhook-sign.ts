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
 * Returns "sha256=<hex>" suitable for the X-Releases-Signature header.
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
 * Low-level primitive: constant-time verify against a candidate signature in
 * "sha256=<hex>" form. Returns false on any malformed input rather than
 * throwing. For subscriber-facing verification use `verifyWithReplayGuard`,
 * which also enforces a timestamp window against replay attacks.
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

/**
 * Default skew window matches Stripe/GitHub/Svix conventions. Any caller
 * that wants a tighter window can pass `maxSkewSeconds`.
 */
export const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export type ReplayGuardResult =
  | { valid: true }
  | {
      valid: false;
      reason: "invalid_timestamp" | "timestamp_outside_window" | "signature_mismatch";
    };

/**
 * Verify a signed webhook payload AND enforce a timestamp window. The
 * timestamp is part of the signed input, so the window check is free
 * once the signature has been verified — but we check timestamp first
 * so a replayed-but-still-cryptographically-valid request can be rejected
 * without paying for HMAC.
 *
 * `now` is injectable for tests; defaults to Date.now().
 */
export async function verifyWithReplayGuard(args: {
  rawBody: string;
  signingKeyHex: string;
  signatureHeader: string;
  timestampHeader: string;
  now?: number;
  maxSkewSeconds?: number;
}): Promise<ReplayGuardResult> {
  // Strict integer match — parseInt would silently accept "1700000000junk"
  // and parse just the prefix, which would let a tampered header pass the
  // window check.
  if (!/^-?\d+$/.test(args.timestampHeader)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const ts = Number(args.timestampHeader);
  if (!Number.isSafeInteger(ts)) return { valid: false, reason: "invalid_timestamp" };

  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  const maxSkew = args.maxSkewSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS;
  if (Math.abs(nowSec - ts) > maxSkew) {
    return { valid: false, reason: "timestamp_outside_window" };
  }

  const ok = await verifySignature(args.signingKeyHex, ts, args.rawBody, args.signatureHeader);
  return ok ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}
