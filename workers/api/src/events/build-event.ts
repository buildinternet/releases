import type { MediaItem } from "@releases/lib/api-types";
import type { ReleaseEventPayload } from "./types.js";

/** Minimal inserted-row shape the batch handler + cron fetchOne already build. */
export interface InsertedReleaseRow {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  /** JSON string as written to D1 (`releases.media`). May be null. */
  media: string | null;
}

export interface BuildEventsInput {
  src: { name: string; slug: string };
  inserted: InsertedReleaseRow[];
}

function parseMedia(raw: string | null): MediaItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MediaItem[];
  } catch {
    return [];
  }
}

/** Map inserted rows + source context to event payloads. Pure; no I/O. */
export function buildReleaseEventPayloads(input: BuildEventsInput): ReleaseEventPayload[] {
  return input.inserted.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    publishedAt: r.publishedAt,
    sourceName: input.src.name,
    sourceSlug: input.src.slug,
    contentSummary: null,
    media: parseMedia(r.media),
  }));
}
