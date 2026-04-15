import { createHash } from "crypto";
import type { RawRelease } from "./types.js";

export function contentHash(raw: RawRelease): string {
  const input = raw.title + (raw.version || "") + (raw.publishedAt?.toISOString() || "") + raw.content;
  return createHash("sha256").update(input).digest("hex");
}
