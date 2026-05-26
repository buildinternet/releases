/**
 * Ingest-time R2 upload of release media (#1177).
 *
 * Mirrors surviving third-party release images into the `released-media` R2
 * bucket so they're served same-origin from `media.releases.sh`. Each uploaded
 * item gets its `r2Key` stamped on; read paths resolve that to a public
 * `r2Url` (`parseReleaseMedia` / `resolveR2Url`).
 *
 * Bounded + fail-open by design: a slow or broken image must never block a
 * release from being ingested. Any fetch error, timeout, non-image response,
 * out-of-range size, R2 `put` error, or registry insert error leaves the
 * original third-party URL in place (no `r2Key`) and logs a warning.
 *
 * Pairs with the cheap URL-only `filterJunkMedia` pre-filter
 * (`@releases/rendering/media-filter`), which callers run first; this module
 * adds the post-fetch content-type + byte-size gate that catches tracking
 * pixels / spacers not distinguishable by URL.
 */
import { mediaAssets } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../db.js";

/** Below this many bytes an image is almost certainly a spacer / pixel. */
export const MEDIA_MIN_BYTES = 1024;
/** Above this many bytes we don't mirror (likely not a thumbnail-worthy asset). */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_CONCURRENCY = 4;

/** Content types we mirror, mapped to the R2 key extension. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

export interface ProcessMediaOptions {
  db: D1Db;
  /** The `released-media` R2 bucket binding (`env.MEDIA`). */
  bucket: R2Bucket;
  sourceId?: string | null;
  releaseId?: string | null;
  /** Max images uploaded per call; extras pass through untouched. */
  maxItems?: number;
  perItemTimeoutMs?: number;
  concurrency?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the registry `createdAt`. */
  now?: () => string;
}

/**
 * Upload each eligible media item to R2 and stamp its `r2Key`. Returns a new
 * array of (shallow-copied) items so adapter-returned objects aren't mutated.
 * Items that fail any gate keep their original third-party `url` and no
 * `r2Key`.
 */
export async function processMediaForR2<T extends { url: string; r2Key?: string }>(
  media: readonly T[],
  opts: ProcessMediaOptions,
): Promise<T[]> {
  const items = media.map((m) => ({ ...m }));
  if (items.length === 0) return items;

  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const timeoutMs = opts.perItemTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());

  const toProcess = items.slice(0, maxItems);

  const uploadOne = async (item: T): Promise<void> => {
    try {
      const res = await fetchWithTimeout(item.url, timeoutMs, fetchImpl);
      if (!res.ok) {
        logSkip("fetch-not-ok", item.url, opts.sourceId, { status: res.status });
        return;
      }
      const contentType = (res.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const ext = CONTENT_TYPE_EXT[contentType];
      if (!ext) {
        logSkip("not-image", item.url, opts.sourceId, { contentType });
        return;
      }
      const buf = await res.arrayBuffer();
      const byteSize = buf.byteLength;
      if (byteSize < MEDIA_MIN_BYTES || byteSize > MEDIA_MAX_BYTES) {
        logSkip("size-out-of-range", item.url, opts.sourceId, { byteSize });
        return;
      }

      const contentHash = await sha256Hex(buf);
      const r2Key = `releases/${contentHash}.${ext}`;

      await opts.bucket.put(r2Key, buf, { httpMetadata: { contentType } });
      // The object now exists in R2 (idempotent: identical bytes → identical
      // key), so stamp r2Key immediately. The registry write below is
      // bookkeeping for observability / dedup / backfill — a failure there
      // must not strip the user-facing same-origin URL.
      item.r2Key = r2Key;

      try {
        await opts.db
          .insert(mediaAssets)
          .values({
            r2Key,
            sourceUrl: item.url,
            sourceFilename: filenameFromUrl(item.url),
            contentType,
            contentHash,
            byteSize,
            sourceId: opts.sourceId ?? null,
            releaseId: opts.releaseId ?? null,
            createdAt: now(),
          })
          .onConflictDoNothing();
      } catch (err) {
        logEvent("warn", {
          component: "media-r2-upload",
          event: "registry-insert-failed",
          sourceId: opts.sourceId ?? null,
          url: item.url,
          err,
        });
      }
    } catch (err) {
      logEvent("warn", {
        component: "media-r2-upload",
        event: "upload-failed",
        sourceId: opts.sourceId ?? null,
        url: item.url,
        err,
      });
    }
  };

  await mapLimit(toProcess, concurrency, uploadOne);
  return items;
}

function logSkip(
  event: string,
  url: string,
  sourceId: string | null | undefined,
  extra: Record<string, unknown>,
): void {
  logEvent("warn", {
    component: "media-r2-upload",
    event,
    sourceId: sourceId ?? null,
    url,
    ...extra,
  });
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function filenameFromUrl(url: string): string | null {
  try {
    const base = new URL(url).pathname.split("/").pop() ?? "";
    return base.length > 0 ? base : null;
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<I>(
  items: readonly I[],
  limit: number,
  fn: (item: I) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    let next = queue.shift();
    while (next !== undefined) {
      await fn(next);
      next = queue.shift();
    }
  });
  await Promise.all(workers);
}
