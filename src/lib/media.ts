import { createHash } from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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

const SKIP_DOMAINS = ["youtube", "vimeo", "loom"];

const DOWNLOAD_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256HexBuffer(buf: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

function isSkippedUrl(url: string): boolean {
  return SKIP_DOMAINS.some((d) => url.includes(d));
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
): Promise<UploadResult | undefined> {
  const apiUrl = config.apiUrl();
  const apiKey = config.apiKey();

  if (!apiUrl || !apiKey) {
    logger.debug("uploadToR2: skipping — not in remote mode");
    return undefined;
  }

  if (isSkippedUrl(mediaUrl)) {
    logger.debug("uploadToR2: skipping streaming embed URL", mediaUrl);
    return undefined;
  }

  let response: Response;
  try {
    response = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        "User-Agent": "released-bot/1.0 (+https://releases.sh)",
      },
    });
  } catch (err) {
    logger.debug("uploadToR2: fetch failed for", mediaUrl, err);
    return undefined;
  }

  if (!response.ok) {
    logger.debug("uploadToR2: non-OK status", response.status, "for", mediaUrl);
    return undefined;
  }

  // Check content-type
  const rawContentType = response.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0].trim().toLowerCase();

  if (!UPLOADABLE_CONTENT_TYPES.has(contentType)) {
    logger.debug("uploadToR2: unsupported content-type", contentType, "for", mediaUrl);
    return undefined;
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
      return undefined;
    }
  }

  // Read body
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch (err) {
    logger.debug("uploadToR2: failed to read body for", mediaUrl, err);
    return undefined;
  }

  if (body.byteLength > MAX_BYTES) {
    logger.debug(
      "uploadToR2: skipping — body size",
      body.byteLength,
      "exceeds 10 MB for",
      mediaUrl
    );
    return undefined;
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
    const putRes = await fetch(`${apiUrl}/api/media/${key}`, {
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
      return undefined;
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
    return undefined;
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
}

/**
 * Processes a batch of media refs, uploading uploadable items to R2.
 * Mutates `media` in place by setting `r2Key` where uploads succeed.
 * Returns upload results for media asset registration.
 */
export async function processMediaForR2(
  media: MediaRef[],
  sourceSlug: string,
  onProgress?: (progress: MediaUploadProgress) => void,
): Promise<UploadResult[]> {
  const uploadable = media.filter((m) => !isSkippedUrl(m.url));
  const uploadResults: UploadResult[] = [];
  let failed = 0;
  const skipped = media.length - uploadable.length;

  // Process in batches of 5
  const BATCH_SIZE = 5;
  for (let i = 0; i < uploadable.length; i += BATCH_SIZE) {
    const batch = uploadable.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((m) => uploadToR2(m.url, sourceSlug))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value) {
        batch[j].r2Key = result.value.r2Key;
        uploadResults.push(result.value);
      } else {
        failed++;
      }
    }

    onProgress?.({
      uploaded: uploadResults.length,
      total: uploadable.length,
      failed,
      skipped,
    });
  }

  return uploadResults;
}
