/**
 * AES-256-GCM envelope for workspace OAuth secrets at rest.
 *
 * Reuses the 32-byte base64 `IDEMPOTENCY_ENCRYPTION_KEY` (the existing
 * encrypted-at-rest key) with AAD bound to workspace + provider + field so a
 * ciphertext cannot be swapped across rows or fields. Same key format as
 * `idempotency-crypto.ts`; different envelope so the two never mix.
 */

const ENVELOPE_VERSION = 1;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EncryptedEnvelope {
  v: 1;
  kid: string;
  iv: string;
  ciphertext: string;
}

export type OAuthTokenField = "access_token" | "refresh_token" | "code_verifier";

export interface OAuthTokenBinding {
  workspaceId: string;
  provider: string;
  field: OAuthTokenField;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error("Invalid base64 value");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) {
    throw new Error("Invalid base64 value");
  }
  return bytes;
}

function parseRawKey(rawKey: string): Uint8Array {
  const key = decodeBase64(rawKey);
  if (key.byteLength !== AES_KEY_BYTES) {
    throw new Error("OAuth token encryption key must contain exactly 32 bytes");
  }
  return key;
}

export function validateOAuthTokenEncryptionKey(rawKey: string): void {
  parseRawKey(rawKey);
}

async function keyFingerprint(key: Uint8Array): Promise<string> {
  return encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", copyBuffer(key))));
}

function encodeAad(binding: OAuthTokenBinding): Uint8Array {
  return encoder.encode(
    `uploads-oauth-v1|${binding.workspaceId}|${binding.provider}|${binding.field}`,
  );
}

function parseEnvelope(value: string): EncryptedEnvelope {
  const envelope = JSON.parse(value) as Partial<EncryptedEnvelope>;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.v !== ENVELOPE_VERSION ||
    typeof envelope.kid !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Invalid OAuth token envelope");
  }
  return envelope as EncryptedEnvelope;
}

export async function encryptOAuthSecret(
  plaintext: string,
  rawKey: string,
  binding: OAuthTokenBinding,
): Promise<string> {
  const keyBytes = parseRawKey(rawKey);
  const key = await crypto.subtle.importKey("raw", copyBuffer(keyBytes), "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: copyBuffer(iv), additionalData: copyBuffer(encodeAad(binding)) },
    key,
    copyBuffer(encoder.encode(plaintext)),
  );
  const envelope: EncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    kid: await keyFingerprint(keyBytes),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

export async function decryptOAuthSecret(
  envelopeValue: string,
  rawKey: string,
  binding: OAuthTokenBinding,
): Promise<string> {
  const keyBytes = parseRawKey(rawKey);
  const envelope = parseEnvelope(envelopeValue);
  if (envelope.kid !== (await keyFingerprint(keyBytes))) {
    throw new Error("OAuth token encryption key fingerprint mismatch");
  }
  const iv = decodeBase64(envelope.iv);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new Error("Invalid AES-GCM IV");
  }
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = await crypto.subtle.importKey("raw", copyBuffer(keyBytes), "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: copyBuffer(iv), additionalData: copyBuffer(encodeAad(binding)) },
    key,
    copyBuffer(ciphertext),
  );
  return decoder.decode(plaintext);
}
