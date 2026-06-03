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
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { mediaAssets, releases } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";

// Loose drizzle handle (matches the worker-helper convention in
// `appstore-materialize.ts`) so both the schema-typed `createDb` result and
// poll-fetch's `ReturnType<typeof drizzle>` handle pass without a cast.
type Db = ReturnType<typeof drizzle>;

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

/**
 * Ceiling on the MP4 we buffer from a GIF→MP4 transcode (#1368). A GIF→MP4 is
 * ~95% smaller, so even a 100 MB GIF (the Media Transformations input cap) lands
 * far under this; a transcode that somehow exceeds it is skipped (fail-open to
 * the third-party GIF URL). Intentionally larger than `MEDIA_MAX_BYTES` because
 * the GIF input is deliberately not bounded by that cap.
 */
export const MP4_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Minimal shape of the Cloudflare Media Transformations Workers binding (wrangler
 * `"media": { "binding": "MEDIA_TRANSFORM" }`). Hand-typed — the product type
 * isn't in our `@cloudflare/workers-types` yet — modeling only the
 * `input → output → media/contentType` chain we use. `.transform()` is optional
 * and unused here: a pure GIF→MP4 transcode needs only `input → output`
 * (confirmed via a live spike). See docs/architecture/web.md (Media handling).
 */
export interface MediaTransformResult {
  media(): Promise<ReadableStream<Uint8Array>>;
  contentType(): Promise<string>;
}
export interface MediaTransformInput {
  transform(opts: Record<string, unknown>): MediaTransformInput;
  output(opts: { mode: "video" | "frame" }): MediaTransformResult;
}
export interface MediaTransformBinding {
  input(stream: ReadableStream<Uint8Array>): MediaTransformInput;
}

export interface ProcessMediaOptions {
  db: Db;
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
  /**
   * Cloudflare Media Transformations binding (`env.MEDIA_TRANSFORM`). When present
   * AND `transcodeGif` is set, an `image/gif` is streamed through it to an MP4 and
   * only the small MP4 is stored at `releases/<hash>.mp4` — the heavy raw GIF is
   * never buffered or stored (#1368). Absent → GIFs are stored verbatim as before.
   */
  mediaTransform?: MediaTransformBinding;
  /** Gate for the GIF→MP4 transcode branch (flag `media-gif-transcode-enabled`). */
  transcodeGif?: boolean;
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
): Promise<Array<T & { r2Key?: string }>> {
  const items: Array<T & { r2Key?: string }> = media.map((m) => ({ ...m }));
  if (items.length === 0) return items;

  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const timeoutMs = opts.perItemTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());

  const toProcess = items.slice(0, maxItems);

  const uploadOne = async (item: T & { r2Key?: string }): Promise<void> => {
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

      // GIF → MP4 transcode branch (#1368). Stream the (possibly large) GIF
      // straight into the Media Transformations binding and store ONLY the small
      // MP4 — the raw GIF is never buffered or stored, sidestepping MEDIA_MAX_BYTES
      // for GIFs. Fail-open: a missing body or any transcode error leaves the
      // third-party URL in place (no r2Key), exactly like a GIF that fails to
      // mirror today. The stored MP4 lets the serve layer skip the per-view
      // cross-origin transform (web/src/lib/media.ts releaseVideoUrl).
      if (opts.transcodeGif && opts.mediaTransform && contentType === "image/gif") {
        if (!res.body) {
          logSkip("gif-no-body", item.url, opts.sourceId, {});
          return;
        }
        const mp4 = await transcodeGifToMp4(res.body, opts.mediaTransform);
        if (mp4 === null) {
          logSkip("gif-transcode-failed", item.url, opts.sourceId, {});
          return;
        }
        const mp4Hash = await sha256Hex(mp4);
        const mp4Key = `releases/${mp4Hash}.mp4`;
        await opts.bucket.put(mp4Key, mp4, { httpMetadata: { contentType: "video/mp4" } });
        item.r2Key = mp4Key;
        await registerMediaAsset(opts, {
          r2Key: mp4Key,
          sourceUrl: item.url,
          contentType: "video/mp4",
          contentHash: mp4Hash,
          byteSize: mp4.byteLength,
          now,
        });
        return;
      }

      // Read with a hard ceiling so a huge (or unbounded / chunked) body can't
      // buffer past the cap into the worker's memory — `arrayBuffer()` would
      // pull the whole response first, then check the size too late.
      const buf = await readBodyBounded(res, MEDIA_MAX_BYTES);
      if (buf === null) {
        logSkip("size-out-of-range", item.url, opts.sourceId, {
          declaredBytes: res.headers.get("content-length"),
        });
        return;
      }
      const byteSize = buf.byteLength;
      if (byteSize < MEDIA_MIN_BYTES) {
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

      await registerMediaAsset(opts, {
        r2Key,
        sourceUrl: item.url,
        contentType,
        contentHash,
        byteSize,
        now,
      });
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

/** D1 caps a prepared statement at 100 bound params; `IN (...)` lookups chunk at 90. */
const URL_LOOKUP_CHUNK = 90;

/**
 * Of `urls`, return the subset that already has a release row under `sourceId`.
 *
 * The media pre-pass gates `processMediaForR2` on this: a release whose URL
 * already exists is skipped by the poll-fetch `onConflictDoNothing` insert, and
 * the `/releases/batch` upsert (`RELEASE_URL_UPSERT`) only ever backfills the
 * `media` column for a stored-empty row and never overwrites populated media —
 * so mirroring an existing row's images to R2 here would fetch + upload bytes
 * whose result is immediately discarded (a row freshly backfilled from empty is
 * R2-mirrored later by the `backfill-media` route). Null/empty URLs aren't
 * queried (a null URL is always a fresh insert under `UNIQUE(source_id, url)`).
 */
export async function selectExistingReleaseUrls(
  db: Db,
  sourceId: string,
  urls: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const distinct = [...new Set(urls.filter((u): u is string => typeof u === "string" && u !== ""))];
  const existing = new Set<string>();
  for (let i = 0; i < distinct.length; i += URL_LOOKUP_CHUNK) {
    const chunk = distinct.slice(i, i + URL_LOOKUP_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- chunked IN lookup (90-id D1 limit)
    const rows = await db
      .select({ url: releases.url })
      .from(releases)
      .where(and(eq(releases.sourceId, sourceId), inArray(releases.url, chunk)));
    for (const r of rows) if (r.url) existing.add(r.url);
  }
  return existing;
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

/**
 * Read a response body into an `ArrayBuffer`, bailing out (→ `null`) the moment
 * it would exceed `maxBytes`. Cheap `Content-Length` pre-check first, then a
 * streamed accumulation so a lying or absent header still can't blow the cap.
 */
async function readBodyBounded(res: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = res.body;
  if (!body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : buf;
  }

  return readStreamBounded(body, maxBytes);
}

/**
 * Accumulate a byte stream into an `ArrayBuffer`, bailing out (→ `null`) the
 * moment it would exceed `maxBytes`. Shared by `readBodyBounded` (response body)
 * and the GIF→MP4 transcode (the binding's MP4 output stream).
 */
async function readStreamBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
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

/**
 * Transcode an animated GIF stream to MP4 via the Media Transformations binding,
 * returning the MP4 bytes (capped at {@link MP4_MAX_BYTES}) or `null` on any
 * failure. Pure transcode — `input → output({mode:"video"})` — no `.transform()`.
 */
async function transcodeGifToMp4(
  gif: ReadableStream<Uint8Array>,
  binding: MediaTransformBinding,
): Promise<ArrayBuffer | null> {
  try {
    const out = await binding.input(gif).output({ mode: "video" }).media();
    return await readStreamBounded(out, MP4_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * Insert a `media_assets` registry row for a stored object. Bookkeeping for
 * observability / dedup / backfill — `onConflictDoNothing` makes it idempotent,
 * and a failure here must never strip the already-stamped user-facing `r2Key`,
 * so it swallows + logs rather than throwing.
 */
async function registerMediaAsset(
  opts: ProcessMediaOptions,
  fields: {
    r2Key: string;
    sourceUrl: string;
    contentType: string;
    contentHash: string;
    byteSize: number;
    now: () => string;
  },
): Promise<void> {
  try {
    await opts.db
      .insert(mediaAssets)
      .values({
        r2Key: fields.r2Key,
        sourceUrl: fields.sourceUrl,
        sourceFilename: filenameFromUrl(fields.sourceUrl),
        contentType: fields.contentType,
        contentHash: fields.contentHash,
        byteSize: fields.byteSize,
        sourceId: opts.sourceId ?? null,
        releaseId: opts.releaseId ?? null,
        createdAt: fields.now(),
      })
      .onConflictDoNothing();
  } catch (err) {
    logEvent("warn", {
      component: "media-r2-upload",
      event: "registry-insert-failed",
      sourceId: opts.sourceId ?? null,
      url: fields.sourceUrl,
      err,
    });
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
      // oxlint-disable-next-line no-await-in-loop -- bounded-concurrency runner; awaiting per slot is the design
      await fn(next);
      next = queue.shift();
    }
  });
  await Promise.all(workers);
}
