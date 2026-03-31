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

// ---------------------------------------------------------------------------
// Core upload function
// ---------------------------------------------------------------------------

/**
 * Downloads one media file and uploads it to R2 via the API.
 * Returns the R2 key on success, or undefined if skipped / failed.
 */
export async function uploadToR2(
  mediaUrl: string,
  sourceSlug: string
): Promise<string | undefined> {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    response = await fetch(mediaUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "released-bot/1.0 (+https://releases.sh)",
      },
    });

    clearTimeout(timer);
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
  const hash = sha256HexBuffer(body).slice(0, 16);
  const ext = CONTENT_TYPE_EXT[contentType] ?? "bin";
  const key = `sources/${sourceSlug}/${hash}.${ext}`;

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
    return key;
  } catch (err) {
    logger.warn("uploadToR2: PUT request failed for key", key, err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

/**
 * Processes a batch of media refs, uploading uploadable items to R2.
 * Mutates `media` in place by setting `r2Key` where uploads succeed.
 */
export async function processMediaForR2(
  media: MediaRef[],
  sourceSlug: string
): Promise<void> {
  const uploadable = media.filter((m) => !isSkippedUrl(m.url));

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
        batch[j].r2Key = result.value;
      }
    }
  }
}
