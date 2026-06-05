/**
 * Pure, runtime-neutral primitives for opaque scoped API tokens.
 * Token format: `relk_<lookupId>_<secret>` (see api-token design spec).
 * Web Crypto only — safe in Workers, Bun, and Node 18+.
 */

import { customAlphabet } from "nanoid";

/** Closed scope vocabulary for v1. Stored per-token as a JSON array. */
export const API_SCOPES = ["read", "write", "admin"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Root wildcard — only the static key holds it; never minted on a DB token. */
export const ROOT_SCOPE = "*";

const SCOPE_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

/**
 * True if a token holding `tokenScopes` satisfies `required`. The wildcard `*`
 * grants everything; otherwise any held scope of equal-or-higher rank satisfies
 * the requirement (admin ⊇ write ⊇ read). Unknown scopes rank 0 (grant nothing)
 * so future namespaced scopes never accidentally satisfy the v1 ladder.
 */
export function scopeSatisfies(tokenScopes: string[], required: ApiScope): boolean {
  if (tokenScopes.includes(ROOT_SCOPE)) return true;
  const reqRank = SCOPE_RANK[required] ?? Number.POSITIVE_INFINITY;
  return tokenScopes.some((s) => (SCOPE_RANK[s] ?? 0) >= reqRank);
}

/** Principal types — whom a token acts as. Mirrored by the `api_tokens.principal_type` column. */
export const PRINCIPAL_TYPES = ["internal", "agent", "user"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * Parse the stored `scopes` JSON column into a string array. Defensive: invalid
 * JSON or a non-array yields `[]`, and non-string elements are dropped.
 */
export function parseStoredScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Wire prefix for Releases API keys — distinct and secret-scanning friendly. */
export const API_TOKEN_PREFIX = "relk_";

// Base62 excludes `_` and `-` (which nanoid's default alphabet includes), so the
// `_` between lookupId and secret is an unambiguous delimiter.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOOKUP_LEN = 12; // ~71 bits; non-secret, unique-indexed
const SECRET_LEN = 32; // ~190 bits; CSPRNG

const genLookup = customAlphabet(BASE62, LOOKUP_LEN);
const genSecret = customAlphabet(BASE62, SECRET_LEN);

const TOKEN_RE = new RegExp(
  `^${API_TOKEN_PREFIX}([0-9A-Za-z]{${LOOKUP_LEN}})_([0-9A-Za-z]{${SECRET_LEN}})$`,
);

export interface GeneratedApiToken {
  /** Full token string — show to the caller exactly once. */
  token: string;
  /** Public, non-secret identifier. Stored plaintext, indexed. */
  lookupId: string;
  /** High-entropy secret. Never stored — only its hash. */
  secret: string;
}

export function generateApiToken(): GeneratedApiToken {
  const lookupId = genLookup();
  const secret = genSecret();
  return { token: `${API_TOKEN_PREFIX}${lookupId}_${secret}`, lookupId, secret };
}

export interface ParsedApiToken {
  lookupId: string;
  secret: string;
}

export function parseApiToken(raw: string): ParsedApiToken | null {
  const m = raw.trim().match(TOKEN_RE);
  if (!m) return null;
  return { lookupId: m[1], secret: m[2] };
}

/** Cheap prefix check used to route a credential to the DB-token path. */
export function isApiTokenShaped(raw: string): boolean {
  return raw.startsWith(API_TOKEN_PREFIX);
}

/**
 * Wire prefix for Better Auth-issued, user-owned API keys. Distinct from the
 * machine-lane `API_TOKEN_PREFIX` (`relk_`) so the auth middleware routes a
 * presented credential to exactly one verifier. Set as the plugin's
 * `defaultPrefix` in workers/api/src/auth/index.ts.
 */
export const USER_API_KEY_PREFIX = "relu_";

/** Cheap prefix check routing a credential to the Better Auth verify path. */
export function isUserApiKeyShaped(raw: string): boolean {
  return raw.startsWith(USER_API_KEY_PREFIX);
}

/**
 * The single OAuth client id permitted to run the device-authorization flow
 * (RFC 8628) that backs `releases login`. The CLI sends this as `client_id`; the
 * API worker's `validateClient` allow-list (workers/api/src/auth/index.ts) rejects
 * anything else (fail closed). A public, non-secret identifier — it lives here so
 * the OSS CLI and the worker share ONE source of truth instead of hard-coding it
 * on each side and silently drifting.
 */
export const DEVICE_AUTH_CLIENT_ID = "releases-cli";

/** SHA-256 of the secret as lowercase hex. Web Crypto — runtime-neutral. */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Content-constant-time string comparison. Loops over the longer length and
 * folds a length mismatch into the result so neither timing nor early-return
 * reveals where two strings diverge.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Fixed dummy hash used on the not-found / malformed path so a real miss runs
 * the same comparison work as a wrong-secret on an existing row — no timing or
 * response-shape enumeration oracle.
 */
export const DUMMY_TOKEN_HASH = "0".repeat(64);
