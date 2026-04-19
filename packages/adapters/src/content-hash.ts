import { sha256Hex } from "@releases/core-internal/hash";
import type { RawRelease } from "./types.js";

export function contentHash(raw: RawRelease): string {
  return sha256Hex(raw.title + (raw.version || "") + (raw.publishedAt?.toISOString() || "") + raw.content);
}
