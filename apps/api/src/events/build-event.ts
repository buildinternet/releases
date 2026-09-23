import type { MediaItem } from "@buildinternet/releases-api-types";
import type { ReleaseType } from "@buildinternet/releases-core/schema";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";
import type { ReleaseEventPayload } from "./types.js";

/** Minimal inserted-row shape the batch handler + cron fetchOne already build. */
export interface InsertedReleaseRow {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  /** JSON string as written to D1 (`releases.media`). May be null. */
  media: string | null;
  /** Cached body size — see {@link ReleaseEventPayload}. Null when unset. */
  contentChars?: number | null;
  contentTokens?: number | null;
  type?: ReleaseType;
}

export interface BuildEventsInput {
  src: {
    name: string;
    slug: string;
    /** Source type, surfaced on the event so the live feed can render its icon. */
    type?: string;
    /** Owning-org context, resolved by the publisher. `null` for orphan sources. */
    org?: {
      slug: string;
      name: string;
      avatarUrl: string | null;
      githubHandle: string | null;
    } | null;
    /** Owning product, when the source is grouped under one. */
    product?: { slug: string; name: string } | null;
  };
  inserted: InsertedReleaseRow[];
  /**
   * Absolute web origin (no trailing slash) for building each payload's
   * `webUrl`. Resolved by the publisher from `WEB_BASE_URL`. Omit to leave
   * `webUrl` absent (e.g. tests that don't exercise the link).
   */
  webBase?: string;
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
    sourceType: input.src.type,
    org: input.src.org ?? null,
    product: input.src.product ?? null,
    // Slug derives from title/version — the AI headlines are still null here.
    webUrl: input.webBase ? releaseWebUrl(input.webBase, r) : null,
    summary: null,
    titleGenerated: null,
    titleShort: null,
    media: parseMedia(r.media),
    contentChars: r.contentChars ?? null,
    contentTokens: r.contentTokens ?? null,
  }));
}
