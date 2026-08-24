import type { Context } from "hono";
import {
  ConflictError,
  isReleasesError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from "@releases/lib/releases-error";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import {
  decryptIdempotencyBody,
  encryptIdempotencyBody,
  validateIdempotencyEncryptionKey,
} from "../lib/idempotency-crypto.js";
import type { IdempotencyPrincipal } from "../lib/idempotency-principal.js";
import {
  claimIdempotency,
  completeIdempotency,
  releaseIdempotency,
  retainIdempotency,
} from "../lib/idempotency-store.js";
import { respondError } from "../lib/error-response.js";

const MAX_BODY_BYTES = 64 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7e]{16,255}$/;
const encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function unavailable(c: Context<Env>): Response {
  return respondError(
    c,
    new ServiceUnavailableError("Idempotency is temporarily unavailable", {
      code: "idempotency_unavailable",
    }),
  );
}

function encodeFields(fields: readonly Uint8Array[]): Uint8Array {
  const byteLength = fields.reduce((total, field) => total + 4 + field.byteLength, 0);
  const encoded = new Uint8Array(byteLength);
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength);
    offset += 4;
    encoded.set(field, offset);
    offset += field.byteLength;
  }
  return encoded;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copyBuffer(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPrincipal(principal: IdempotencyPrincipal): Promise<string> {
  return sha256Hex(
    encodeFields([
      encoder.encode("idempotency-principal-v1"),
      encoder.encode(principal.namespace),
      encoder.encode(principal.id),
    ]),
  );
}

async function readBodyLimited(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- streaming cap must inspect each chunk
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError("Payload exceeds the 64 KiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function contentLengthExceedsLimit(value: string | undefined): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  return Number(value) > MAX_BODY_BYTES;
}

async function requestBytes(c: Context<Env>): Promise<Uint8Array> {
  if (contentLengthExceedsLimit(c.req.header("content-length"))) {
    throw new PayloadTooLargeError("Payload exceeds the 64 KiB limit");
  }
  return readBodyLimited(c.req.raw.clone().body);
}

async function requestFingerprint(c: Context<Env>, body: Uint8Array): Promise<string> {
  const url = new URL(c.req.url);
  return sha256Hex(
    encodeFields([
      encoder.encode("idempotency-request-v1"),
      encoder.encode(c.req.method),
      encoder.encode(url.pathname),
      encoder.encode(url.search.slice(1)),
      encoder.encode((c.req.header("content-type") ?? "").trim().toLowerCase()),
      body,
    ]),
  );
}

function recordableContentType(value: string | null): boolean {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
  const charset = parameters
    .map((parameter) => parameter.split("=", 2))
    .find(([name]) => name === "charset")?.[1]
    ?.replace(/^"|"$/g, "");
  if (charset && charset !== "utf-8" && charset !== "utf8") return false;
  return (
    mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json")
  );
}

function storedHeaders(response: Response): string {
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  const location = response.headers.get("location");
  if (contentType !== null) headers["content-type"] = contentType;
  if (location !== null) headers.location = location;
  return JSON.stringify(headers);
}

function replayHeaders(value: string): Headers {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid stored idempotency headers");
  }
  const headers = new Headers();
  for (const name of ["content-type", "location"] as const) {
    const header = (parsed as Record<string, unknown>)[name];
    if (header !== undefined) {
      if (typeof header !== "string") throw new Error("Invalid stored idempotency header");
      headers.set(name, header);
    }
  }
  headers.set("Idempotency-Replayed", "true");
  return headers;
}

async function confirmedRelease(
  db: ReturnType<typeof createDb>,
  identity: { principalHash: string; keyHash: string; attemptId: string },
): Promise<boolean> {
  try {
    return await releaseIdempotency(db, identity);
  } catch {
    return false;
  }
}

async function confirmedRetention(
  db: ReturnType<typeof createDb>,
  input: Parameters<typeof retainIdempotency>[1],
): Promise<boolean> {
  try {
    return await retainIdempotency(db, input);
  } catch {
    return false;
  }
}

export async function idempotentPost<T>(
  c: Context<Env>,
  options: {
    principal: IdempotencyPrincipal | null;
    body: "json" | "empty";
    preclaim: () => Promise<T | Response>;
    execute: (input: T) => Promise<Response>;
  },
): Promise<Response> {
  const rawIdempotencyKey = c.req.header("idempotency-key");
  if (rawIdempotencyKey === undefined) {
    const input = await options.preclaim();
    return input instanceof Response ? input : options.execute(input);
  }

  if (!KEY_PATTERN.test(rawIdempotencyKey)) {
    return respondError(c, new ValidationError("Invalid Idempotency-Key"));
  }
  if (!options.principal) return unavailable(c);

  let rawEncryptionKey: string;
  try {
    const binding = c.env.IDEMPOTENCY_ENCRYPTION_KEY;
    if (!binding) return unavailable(c);
    rawEncryptionKey = await binding.get();
    validateIdempotencyEncryptionKey(rawEncryptionKey);
  } catch {
    return unavailable(c);
  }

  let body: Uint8Array;
  try {
    body = await requestBytes(c);
  } catch (error) {
    if (isReleasesError(error)) return respondError(c, error);
    return respondError(c, new ValidationError("Unable to read request body"));
  }
  if (options.body === "empty" && body.byteLength > 0) {
    return respondError(c, new ValidationError("This endpoint does not accept a request body"));
  }

  const [principalHash, keyHash, requestHash] = await Promise.all([
    hashPrincipal(options.principal),
    sha256Hex(encoder.encode(rawIdempotencyKey)),
    requestFingerprint(c, body),
  ]);
  const preclaimInput = await options.preclaim();
  if (preclaimInput instanceof Response) return preclaimInput;

  const db = createDb(c.env.DB);
  const now = new Date();
  const claimInput = {
    principalHash,
    keyHash,
    requestHash,
    attemptId: crypto.randomUUID(),
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
  };
  let claim: Awaited<ReturnType<typeof claimIdempotency>>;
  try {
    claim = await claimIdempotency(db, claimInput);
  } catch {
    return unavailable(c);
  }

  if (claim.kind === "conflict") {
    return respondError(
      c,
      new ConflictError("Idempotency key was already used for a different request", {
        code: "idempotency_conflict",
      }),
    );
  }
  if (claim.kind === "processing") {
    const response = respondError(
      c,
      new ConflictError("A matching request is already in progress", {
        code: "idempotency_in_progress",
      }),
    );
    response.headers.set("Retry-After", "1");
    return response;
  }
  if (claim.kind === "unavailable") return unavailable(c);
  if (claim.kind === "completed") {
    try {
      const plaintext = await decryptIdempotencyBody(claim.record.responseBody, rawEncryptionKey, {
        principalHash,
        keyHash,
        requestHash,
        status: claim.record.responseStatus,
      });
      return new Response(copyBuffer(plaintext), {
        status: claim.record.responseStatus,
        headers: replayHeaders(claim.record.responseHeaders),
      });
    } catch {
      return unavailable(c);
    }
  }

  const identity = { principalHash, keyHash, attemptId: claim.attemptId };
  let response: Response;
  try {
    response = await options.execute(preclaimInput);
  } catch (error) {
    if (isReleasesError(error) && error.status >= 400 && error.status < 500) {
      if (!(await confirmedRelease(db, identity))) {
        await confirmedRetention(db, claimInput);
        return unavailable(c);
      }
    }
    throw error;
  }

  if (response.status >= 300 && response.status < 500) {
    if (await confirmedRelease(db, identity)) return response;
    await confirmedRetention(db, claimInput);
    return unavailable(c);
  }
  if (response.status < 200 || response.status >= 300) return response;

  try {
    if (!recordableContentType(response.headers.get("content-type"))) {
      throw new Error("Unrecordable response content type");
    }
    const responseBytes = await readBodyLimited(response.clone().body);
    fatalUtf8Decoder.decode(responseBytes);
    const encryptedBody = await encryptIdempotencyBody(responseBytes, rawEncryptionKey, {
      principalHash,
      keyHash,
      requestHash,
      status: response.status,
    });
    const completed = await completeIdempotency(db, {
      ...identity,
      responseStatus: response.status,
      responseHeaders: storedHeaders(response),
      responseBody: encryptedBody,
      completedAt: new Date().toISOString(),
    });
    if (!completed) {
      await confirmedRetention(db, claimInput);
      return unavailable(c);
    }
  } catch {
    await confirmedRetention(db, claimInput);
    return unavailable(c);
  }
  return response;
}
