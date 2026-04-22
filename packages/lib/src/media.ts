import { normalizeMediaUrl } from "./media-url.js";

export { normalizeMediaUrl };

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
