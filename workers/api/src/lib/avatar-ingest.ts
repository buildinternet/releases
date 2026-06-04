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

function reject(status: AvatarRejectStatus, error: string, message: string): AvatarIngestResult {
  return { ok: false, status, error, message };
}

export async function ingestOrgAvatar(opts: AvatarIngestOptions): Promise<AvatarIngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let parsed: URL;
  try {
    parsed = new URL(opts.sourceUrl);
  } catch {
    return reject(400, "invalid_source_url", "sourceUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return reject(400, "invalid_source_url", "sourceUrl must be an http(s) URL");
  }

  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    res = await fetchImpl(opts.sourceUrl, { signal: controller.signal });
  } catch (err) {
    logEvent("warn", {
      component: "org-avatar",
      event: "fetch-failed",
      slug: opts.slug,
      url: opts.sourceUrl,
      err,
    });
    return reject(502, "fetch_failed", "Could not fetch the source image");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return reject(502, "fetch_failed", `Source image returned HTTP ${res.status}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) {
    return reject(
      415,
      "unsupported_type",
      `Unsupported image type "${contentType || "unknown"}" — png, jpeg, gif, or webp only`,
    );
  }

  const buf = await readBodyBounded(res, AVATAR_MAX_BYTES);
  if (buf === null) {
    return reject(413, "too_large", `Image exceeds the ${AVATAR_MAX_BYTES}-byte cap`);
  }
  if (buf.byteLength < AVATAR_MIN_BYTES) {
    return reject(
      422,
      "too_small",
      `Image is only ${buf.byteLength} bytes — likely not a real icon`,
    );
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

  const key = `orgs/${opts.slug}.${ext}`;
  try {
    await opts.bucket.put(key, buf, { httpMetadata: { contentType } });
  } catch (err) {
    logEvent("warn", {
      component: "org-avatar",
      event: "r2-put-failed",
      slug: opts.slug,
      key,
      err,
    });
    return reject(502, "store_failed", "Could not store the image");
  }

  const avatarUrl = `${opts.mediaOrigin.replace(/\/+$/, "")}/${key}`;
  logEvent("info", {
    component: "org-avatar",
    event: "stored",
    slug: opts.slug,
    key,
    width: dims.width,
    height: dims.height,
    bytes: buf.byteLength,
  });
  return {
    ok: true,
    avatarUrl,
    key,
    width: dims.width,
    height: dims.height,
    bytes: buf.byteLength,
  };
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
