/**
 * One-step org avatar ingest (#1406): fetch a remote image, validate it's a
 * reasonable square raster, and mirror it to the `released-media` R2 bucket at the
 * canonical `orgs/{slug}.{ext}` key (served from `media.releases.sh`). The route
 * sets `organizations.avatar_url` to the returned URL.
 *
 * Bounded by design — timeout + size cap + a header-only dimension sniff (Workers
 * have no image library, see ./image-dims) — and returns a typed `{ ok: false,
 * status, error, message }` for every reject so the route can surface a precise
 * HTTP error instead of silently storing junk.
 */
import { logEvent } from "@releases/lib/log-event";
import { sniffImageDimensions } from "./image-dims.js";

const TIMEOUT_MS = 5_000;
/** Below this an "image" is almost certainly a spacer / error page. */
export const AVATAR_MIN_BYTES = 1024;
/** Above this we don't mirror (an avatar should never be this big). */
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
/** Minimum width AND height — rejects favicons / tiny thumbnails. */
export const AVATAR_MIN_DIMENSION = 128;
/** Shorter side must be ≥ this fraction of the longer side — rejects wordmarks. */
export const AVATAR_MIN_SQUARENESS = 0.8;

/** Accepted raster content types → R2 key extension. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type AvatarRejectStatus = 400 | 413 | 415 | 422 | 502;

export type AvatarIngestResult =
  | { ok: true; avatarUrl: string; key: string; width: number; height: number; bytes: number }
  | { ok: false; status: AvatarRejectStatus; error: string; message: string };

export interface AvatarIngestOptions {
  /** Remote image URL to mirror. */
  sourceUrl: string;
  /** Canonical org slug — the R2 key is `orgs/{slug}.{ext}`. */
  slug: string;
  /** The `released-media` R2 bucket binding (`env.MEDIA`). */
  bucket: R2Bucket;
  /** Public media origin, e.g. `https://media.releases.sh` (`env.MEDIA_ORIGIN`). */
  mediaOrigin: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface AvatarBufferIngestOptions {
  /** Raw image bytes (already bounded by the caller when read from multipart). */
  buf: ArrayBuffer;
  /** Declared raster content type — drives the R2 key extension. */
  contentType: string;
  /**
   * R2 key stem without extension, e.g. `users/{userId}` or `workspaces/{orgId}`.
   * The stored key is `{keyStem}.{ext}`.
   */
  keyStem: string;
  bucket: R2Bucket;
  mediaOrigin: string;
  /** Log component tag — defaults to `avatar`. */
  component?: string;
}

/** True when `url` is a mirrored avatar we host under `mediaOrigin/{prefix}`. */
export function isHostedAvatarUrl(
  url: string | null | undefined,
  mediaOrigin: string,
  prefix: "users/" | "workspaces/" | "orgs/",
): boolean {
  if (!url) return false;
  const origin = mediaOrigin.replace(/\/+$/, "");
  return url.startsWith(`${origin}/${prefix}`);
}

/** Strip provider `image` updates when the user already has a hosted avatar. */
export function preserveCustomAvatarOnUpdate(
  data: Record<string, unknown>,
  currentImage: string | null | undefined,
  mediaOrigin: string,
): { data: Record<string, unknown> } | undefined {
  if (!("image" in data)) return undefined;
  if (!isHostedAvatarUrl(currentImage, mediaOrigin, "users/")) return undefined;
  const { image: _drop, ...rest } = data;
  return { data: rest };
}

function reject(status: AvatarRejectStatus, error: string, message: string): AvatarIngestResult {
  return { ok: false, status, error, message };
}

/** Max redirect hops to follow (each re-validated). github.com/{h}.png 302s once. */
const MAX_REDIRECTS = 4;

/**
 * SSRF guard: is this hostname a private / loopback / link-local address or an
 * obviously-internal name? Workers can't pre-resolve DNS, so this is best-effort —
 * it blocks literal private IPs (incl. the cloud-metadata 169.254/16), localhost
 * and single-label / internal hostnames, and is re-applied to every redirect hop.
 * A public name that resolves to a private IP (DNS rebinding) can't be caught here
 * without resolver access; the manual-redirect re-validation narrows even that.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal") || h === "metadata.google.internal") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true; // malformed
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (h.includes(":")) {
    // IPv6 literal.
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
    if (h.startsWith("fe80") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
      return true; // link-local fe80::/10
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mapped) return isPrivateOrLocalHost(mapped[1]!);
    return false;
  }

  // No dot, not an IP → single-label / internal hostname.
  if (!h.includes(".")) return true;
  return false;
}

/** Parse + SSRF-screen a URL. Returns the URL or null if it must not be fetched. */
function safeUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (isPrivateOrLocalHost(parsed.hostname)) return null;
  return parsed;
}

/**
 * Fetch following redirects MANUALLY so every hop is SSRF-screened before it's
 * requested (auto-follow would chase a 302 → internal target unchecked). Returns
 * `{ blocked: true }` for an unfetchable/unsafe URL (→ 400) vs `{ res: null }` for
 * a transport failure or redirect loop (→ 502, generic message — never echo the
 * upstream status, so the endpoint can't be used as an internal port scanner).
 */
async function fetchImageSafely(
  startUrl: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ blocked: true } | { blocked: false; res: Response | null }> {
  let current = safeUrl(startUrl);
  if (!current) return { blocked: true };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- redirect chain is inherently sequential
      res = await fetchImpl(current.toString(), { signal: controller.signal, redirect: "manual" });
    } catch {
      return { blocked: false, res: null };
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 300 || res.status >= 400) return { blocked: false, res };
    const location = res.headers.get("location");
    if (!location) return { blocked: false, res: null };
    const next = safeUrl(new URL(location, current).toString());
    if (!next) return { blocked: true };
    current = next;
  }
  return { blocked: false, res: null }; // too many redirects
}

type AvatarRasterValidated = { ext: string; dims: { width: number; height: number } };

function validateAvatarRaster(
  buf: ArrayBuffer,
  contentType: string,
): AvatarIngestResult | AvatarRasterValidated {
  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) {
    return reject(
      415,
      "unsupported_type",
      `Unsupported image type "${contentType || "unknown"}" — png, jpeg, gif, or webp only`,
    );
  }
  if (buf.byteLength < AVATAR_MIN_BYTES) {
    return reject(
      422,
      "too_small",
      `Image is only ${buf.byteLength} bytes — likely not a real icon`,
    );
  }
  if (buf.byteLength > AVATAR_MAX_BYTES) {
    return reject(413, "too_large", `Image exceeds the ${AVATAR_MAX_BYTES}-byte cap`);
  }

  const dims = sniffImageDimensions(new Uint8Array(buf));
  if (!dims) {
    return reject(422, "unreadable", "Could not read image dimensions (png, jpeg, gif, or webp)");
  }
  if (dims.width < AVATAR_MIN_DIMENSION || dims.height < AVATAR_MIN_DIMENSION) {
    return reject(
      422,
      "too_small_dimensions",
      `Image is ${dims.width}×${dims.height}; avatars must be at least ${AVATAR_MIN_DIMENSION}px on each side`,
    );
  }
  const squareness = Math.min(dims.width, dims.height) / Math.max(dims.width, dims.height);
  if (squareness < AVATAR_MIN_SQUARENESS) {
    return reject(
      422,
      "not_square",
      `Image is ${dims.width}×${dims.height}; avatars must be roughly square (shorter side ≥ ${Math.round(AVATAR_MIN_SQUARENESS * 100)}% of the longer)`,
    );
  }
  return { ext, dims };
}

async function storeAvatarToR2(opts: {
  buf: ArrayBuffer;
  contentType: string;
  key: string;
  bucket: R2Bucket;
  mediaOrigin: string;
  component: string;
  logContext: Record<string, unknown>;
  dims: { width: number; height: number };
}): Promise<AvatarIngestResult> {
  try {
    await opts.bucket.put(opts.key, opts.buf, { httpMetadata: { contentType: opts.contentType } });
  } catch (err) {
    logEvent("warn", {
      component: opts.component,
      event: "r2-put-failed",
      key: opts.key,
      err,
      ...opts.logContext,
    });
    return reject(502, "store_failed", "Could not store the image");
  }

  const avatarUrl = `${opts.mediaOrigin.replace(/\/+$/, "")}/${opts.key}`;
  logEvent("info", {
    component: opts.component,
    event: "stored",
    key: opts.key,
    width: opts.dims.width,
    height: opts.dims.height,
    bytes: opts.buf.byteLength,
    ...opts.logContext,
  });
  return {
    ok: true,
    avatarUrl,
    key: opts.key,
    width: opts.dims.width,
    height: opts.dims.height,
    bytes: opts.buf.byteLength,
  };
}

/** Validate a bounded raster buffer and mirror it to R2 at `{keyStem}.{ext}`. */
export async function ingestAvatarFromBuffer(
  opts: AvatarBufferIngestOptions,
): Promise<AvatarIngestResult> {
  const contentType = opts.contentType.split(";")[0]!.trim().toLowerCase();
  const validated = validateAvatarRaster(opts.buf, contentType);
  if ("ok" in validated) return validated;

  const key = `${opts.keyStem}.${validated.ext}`;
  return storeAvatarToR2({
    buf: opts.buf,
    contentType,
    key,
    bucket: opts.bucket,
    mediaOrigin: opts.mediaOrigin,
    component: opts.component ?? "avatar",
    logContext: { keyStem: opts.keyStem },
    dims: validated.dims,
  });
}

export async function ingestOrgAvatar(opts: AvatarIngestOptions): Promise<AvatarIngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const fetched = await fetchImageSafely(opts.sourceUrl, fetchImpl);
  if (fetched.blocked) {
    logEvent("warn", {
      component: "org-avatar",
      event: "url-blocked",
      slug: opts.slug,
      url: opts.sourceUrl,
    });
    return reject(400, "invalid_source_url", "sourceUrl must be a public http(s) image URL");
  }
  const res = fetched.res;
  if (!res || !res.ok) {
    logEvent("warn", {
      component: "org-avatar",
      event: "fetch-failed",
      slug: opts.slug,
      url: opts.sourceUrl,
      status: res?.status ?? null,
    });
    return reject(502, "fetch_failed", "Could not fetch the source image");
  }

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const buf = await readBodyBounded(res, AVATAR_MAX_BYTES);
  if (buf === null) {
    return reject(413, "too_large", `Image exceeds the ${AVATAR_MAX_BYTES}-byte cap`);
  }

  return ingestAvatarFromBuffer({
    buf,
    contentType,
    keyStem: `orgs/${opts.slug}`,
    bucket: opts.bucket,
    mediaOrigin: opts.mediaOrigin,
    component: "org-avatar",
  });
}

/**
 * Read a response body into an ArrayBuffer, bailing out (→ null) the moment it
 * would exceed `maxBytes`. Cheap Content-Length pre-check, then a streamed
 * accumulation so a lying/absent header still can't blow the cap.
 */
async function readBodyBounded(res: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = res.body;
  if (!body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- sequential stream drain; cap-bounded early exit
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
