import { createHash } from "crypto";
import { config } from "@releases/lib/config";
import { logger } from "@buildinternet/releases-lib/logger";
import { normalizeMediaUrl } from "./media-url.js";

export { normalizeMediaUrl };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaRef {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Key?: string;
}

/** Metadata returned after a successful R2 upload, used to populate media_assets. */
export interface UploadResult {
  r2Key: string;
  sourceUrl: string;
  sourceFilename: string | null;
  contentType: string;
  contentHash: string;
  byteSize: number;
}

/** Returned when an upload is skipped or fails, with a human-readable reason. */
export interface UploadSkipped {
  skipped: true;
  reason: string;
}

function isSkipped(v: UploadResult | UploadSkipped): v is UploadSkipped {
  return "skipped" in v;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_BYTES = 5 * 1024; // 5 KB — skip tiny avatars and tracking pixels

const UPLOADABLE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "video/mp4",
  "video/webm",
]);

// Map content-type → file extension
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** Streaming-video hosts that are always kept as `type: "video"` references. */
const STREAMING_EMBED_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"];

/** Domains known to serve tracking pixels, not real images. */
const TRACKING_DOMAINS = [
  "px.ads.linkedin.com",
  "t.co",
  "www.facebook.com/tr",
  "analytics.twitter.com",
  "bat.bing.com",
];

/**
 * Deterministic pre-check classifier. Looks at URL signals only (no HTTP).
 * Byte-level checks (size, content-type) happen later in `uploadToR2`.
 *
 * Anything not hard-dropped or hard-kept here — including /avatar, /icon,
 * /logo, /badge paths — falls through as "ambiguous" for the AI classifier.
 * Per the classify-media-relevance skill spec, those are weak negative
 * signals, not hard drops.
 */
export type PreCheckVerdict =
  | { kind: "drop"; reason: string }
  | { kind: "keep"; reason: string }
  | { kind: "ambiguous" };

const TRACKING_PIXEL_PATTERNS = [
  "/1x1.",
  "1x1.png",
  "1x1.gif",
  "/spacer.",
  "/pixel.",
  "/beacon.",
  "/tracking.",
];

export function preCheckMedia(url: string): PreCheckVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Invalid URL — let the uploader handle failure.
    return { kind: "ambiguous" };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const hostAndPath = host + pathname;

  const trackingDomain = TRACKING_DOMAINS.find(
    (d) => host === d || host.endsWith("." + d) || hostAndPath.startsWith(d),
  );
  if (trackingDomain) return { kind: "drop", reason: `tracking domain: ${trackingDomain}` };

  const embedHost = STREAMING_EMBED_HOSTS.find((h) => host === h || host.endsWith("." + h));
  if (embedHost) return { kind: "keep", reason: `streaming embed: ${embedHost}` };
  const filename = pathname.split("/").pop() ?? "";
  if (filename.startsWith("favicon.") || pathname === "/favicon.ico") {
    return { kind: "drop", reason: "favicon" };
  }

  const pixelPattern = TRACKING_PIXEL_PATTERNS.find((p) => pathname.includes(p));
  if (pixelPattern) return { kind: "drop", reason: `tracking pixel pattern: ${pixelPattern}` };

  return { kind: "ambiguous" };
}

export interface FilterResult {
  media: MediaRef[];
  content: string;
  dropped: Array<{ url: string; reason: string }>;
}

/** Async classifier signature, used to inject a stub in tests. */
export type AmbiguousMediaClassifier = (
  items: Array<{ url: string; alt?: string; type: MediaRef["type"] }>,
  ctx: { releaseTitle?: string; releaseContent?: string; sourceSlug?: string },
) => Promise<Array<{ url: string; decision: "keep" | "drop"; confidence: "high" | "low"; reason: string }> | null>;

export interface FilterMediaOptions {
  /** Release title for classifier context. */
  releaseTitle?: string;
  /** Release body for classifier context. */
  releaseContent?: string;
  /** Source slug for logging. */
  sourceSlug?: string;
  /** Override the classifier (used by tests). Default: `classifyAmbiguousMedia`. */
  classifier?: AmbiguousMediaClassifier;
}

/**
 * Filters release-page media using a two-stage pipeline:
 *
 *   1. Cheap deterministic pre-checks (`preCheckMedia`) — tracking domains,
 *      streaming embeds, favicons, 1x1 spacer pixels.
 *   2. AI classifier for the ambiguous middle — URL patterns that overlap
 *      between chrome and editorial content (/avatar, /icon, /logo, etc.).
 *
 * Low-confidence AI drops are kept conservatively (precision-over-recall).
 * If the AI classifier is unavailable, ambiguous items are kept.
 *
 * Also strips markdown image references for dropped URLs from `content`.
 */
export async function filterJunkMedia(
  media: MediaRef[],
  content: string,
  opts: FilterMediaOptions = {},
): Promise<FilterResult> {
  const dropped: Array<{ url: string; reason: string }> = [];
  const kept: MediaRef[] = [];
  const ambiguous: MediaRef[] = [];

  // Normalize proxy URLs (Next/Vercel image optimizers) to the underlying
  // asset. Rewrite the markdown body so later dedupe-by-URL still matches.
  let normalizedContent = content;
  const normalized: MediaRef[] = media.map((m) => {
    const url = normalizeMediaUrl(m.url);
    if (url === m.url) return m;
    normalizedContent = normalizedContent.split(m.url).join(url);
    return { ...m, url };
  });

  for (const item of normalized) {
    const verdict = preCheckMedia(item.url);
    switch (verdict.kind) {
      case "drop":
        dropped.push({ url: item.url, reason: verdict.reason });
        break;
      case "keep":
        kept.push(item);
        break;
      case "ambiguous":
        ambiguous.push(item);
        break;
    }
  }

  // Second stage: classify the ambiguous middle. Low-confidence drops are
  // kept conservatively (precision-over-recall). Missing decisions, thrown
  // classifiers, and null returns all fall back to "keep".
  const decisions = ambiguous.length > 0 ? await runClassifier(ambiguous, opts) : null;
  const decisionByUrl = new Map(decisions?.map((d) => [d.url, d]));
  for (const item of ambiguous) {
    const d = decisionByUrl.get(item.url);
    if (d && d.decision === "drop" && d.confidence === "high") {
      dropped.push({ url: item.url, reason: `classifier: ${d.reason}` });
    } else {
      kept.push(item);
    }
  }

  // Strip dropped image URLs from markdown content
  let cleanContent = normalizedContent;
  for (const { url } of dropped) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleanContent = cleanContent.replace(
      new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, "g"),
      "",
    );
  }

  // Clean up empty lines left by removed images
  cleanContent = cleanContent.replace(/\n{3,}/g, "\n\n").trim();

  return { media: kept, content: cleanContent, dropped };
}

async function runClassifier(
  ambiguous: MediaRef[],
  opts: FilterMediaOptions,
): Promise<Awaited<ReturnType<AmbiguousMediaClassifier>>> {
  const classifier = opts.classifier ?? (await getDefaultClassifier());
  if (!classifier) return null;
  try {
    return await classifier(
      ambiguous.map((m) => ({ url: m.url, alt: m.alt, type: m.type })),
      {
        releaseTitle: opts.releaseTitle,
        releaseContent: opts.releaseContent,
        sourceSlug: opts.sourceSlug,
      },
    );
  } catch (err) {
    logger.debug("filterJunkMedia: classifier threw, keeping ambiguous items", err);
    return null;
  }
}

/**
 * Lazy import to avoid a static dep cycle between `lib/media.ts` and
 * `ai/classify-media.ts` (which transitively imports config/logger/client).
 */
async function getDefaultClassifier(): Promise<AmbiguousMediaClassifier | null> {
  try {
    const mod = await import("../ai/classify-media.js");
    return (items, ctx) => mod.classifyAmbiguousMedia(items, ctx);
  } catch (err) {
    logger.debug("filterJunkMedia: failed to load default classifier", err);
    return null;
  }
}

const DOWNLOAD_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256HexBuffer(buf: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

function isSkippedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return STREAMING_EMBED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/** Extract filename from URL path, e.g. "cli.jpg" from "https://cdn.example.com/posts/cli.jpg" */
export function extractFilename(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop();
    if (lastSegment && /\.\w{2,5}$/.test(lastSegment)) return lastSegment;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core upload function
// ---------------------------------------------------------------------------

/**
 * Downloads one media file and uploads it to R2 via the API.
 * Returns upload metadata on success, or undefined if skipped / failed.
 */
export async function uploadToR2(
  mediaUrl: string,
  sourceSlug: string
): Promise<UploadResult | UploadSkipped> {
  const apiUrl = config.apiUrl();
  const apiKey = config.apiKey();

  if (!apiUrl || !apiKey) {
    logger.debug("uploadToR2: skipping — not in remote mode");
    return { skipped: true, reason: "no API credentials" };
  }

  if (isSkippedUrl(mediaUrl)) {
    logger.debug("uploadToR2: skipping streaming embed URL", mediaUrl);
    return { skipped: true, reason: "streaming embed URL" };
  }

  let response: Response;
  try {
    response = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        "User-Agent": "releases-bot/1.0 (+https://releases.sh)",
      },
    });
  } catch (err) {
    logger.debug("uploadToR2: fetch failed for", mediaUrl, err);
    return { skipped: true, reason: "download failed" };
  }

  if (!response.ok) {
    logger.debug("uploadToR2: non-OK status", response.status, "for", mediaUrl);
    return { skipped: true, reason: `download HTTP ${response.status}` };
  }

  // Check content-type
  const rawContentType = response.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0].trim().toLowerCase();

  if (!UPLOADABLE_CONTENT_TYPES.has(contentType)) {
    logger.debug("uploadToR2: unsupported content-type", contentType, "for", mediaUrl);
    return { skipped: true, reason: `unsupported type: ${contentType}` };
  }

  // Check content-length header before reading body
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = parseInt(contentLengthHeader, 10);
    if (!isNaN(declared) && declared > MAX_BYTES) {
      logger.debug(
        "uploadToR2: skipping — content-length",
        declared,
        "exceeds 10 MB for",
        mediaUrl
      );
      return { skipped: true, reason: "too large (>10MB)" };
    }
  }

  // Read body
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch (err) {
    logger.debug("uploadToR2: failed to read body for", mediaUrl, err);
    return { skipped: true, reason: "download failed" };
  }

  if (body.byteLength > MAX_BYTES) {
    logger.debug(
      "uploadToR2: skipping — body size",
      body.byteLength,
      "exceeds 10 MB for",
      mediaUrl
    );
    return { skipped: true, reason: "too large (>10MB)" };
  }

  if (body.byteLength < MIN_BYTES) {
    logger.debug(
      "uploadToR2: skipping — body size",
      body.byteLength,
      "under 5 KB for",
      mediaUrl
    );
    return { skipped: true, reason: "too small (<5KB)" };
  }

  // Build deterministic R2 key
  const fullHash = sha256HexBuffer(body);
  const hash = fullHash.slice(0, 16);
  const ext = CONTENT_TYPE_EXT[contentType] ?? "bin";
  const key = `sources/${sourceSlug}/${hash}.${ext}`;

  // Extract filename from URL path
  const sourceFilename = extractFilename(mediaUrl);

  // PUT to API
  try {
    const putRes = await fetch(`${apiUrl}/v1/media/${key}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
      },
      body,
    });

    if (!putRes.ok) {
      logger.warn(
        "uploadToR2: PUT failed with status",
        putRes.status,
        "for key",
        key
      );
      return { skipped: true, reason: `upload HTTP ${putRes.status}` };
    }

    logger.debug("uploadToR2: uploaded", key);
    return {
      r2Key: key,
      sourceUrl: mediaUrl,
      sourceFilename,
      contentType,
      contentHash: fullHash,
      byteSize: body.byteLength,
    };
  } catch (err) {
    logger.warn("uploadToR2: PUT request failed for key", key, err);
    return { skipped: true, reason: "upload failed" };
  }
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

export interface MediaUploadProgress {
  uploaded: number;
  total: number;
  failed: number;
  skipped: number;
  /** Aggregated failure reasons, e.g. { "download failed": 2, "too small (<5KB)": 1 } */
  failureReasons: Record<string, number>;
}

export interface MediaUploadResult {
  uploads: UploadResult[];
  failureReasons: Record<string, number>;
}

/**
 * Processes a batch of media refs, uploading uploadable items to R2.
 * Mutates `media` in place by setting `r2Key` where uploads succeed.
 * Returns upload results and aggregated failure reasons.
 */
export async function processMediaForR2(
  media: MediaRef[],
  sourceSlug: string,
  onProgress?: (progress: MediaUploadProgress) => void,
): Promise<MediaUploadResult> {
  const uploadable = media.filter((m) => !isSkippedUrl(m.url));
  const uploadResults: UploadResult[] = [];
  let failed = 0;
  const skipped = media.length - uploadable.length;
  const failureReasons: Record<string, number> = {};

  // Process in batches of 5
  const BATCH_SIZE = 5;
  for (let i = 0; i < uploadable.length; i += BATCH_SIZE) {
    const batch = uploadable.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((m) => uploadToR2(m.url, sourceSlug))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      const val = result.status === "fulfilled" ? result.value : null;
      if (val && !isSkipped(val)) {
        batch[j].r2Key = val.r2Key;
        uploadResults.push(val);
      } else {
        failed++;
        const reason = val && isSkipped(val) ? val.reason : "unexpected error";
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      }
    }

    onProgress?.({
      uploaded: uploadResults.length,
      total: uploadable.length,
      failed,
      skipped,
      failureReasons: { ...failureReasons },
    });
  }

  return { uploads: uploadResults, failureReasons };
}
