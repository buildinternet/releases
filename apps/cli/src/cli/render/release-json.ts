import type {
  LatestRelease,
  MediaItem,
  ReleaseWithSource,
  SearchReleaseHit,
} from "../../api/types.js";
import { cleanExcerpt } from "../../lib/release-display.js";

/**
 * Slim JSON projectors for the release reader commands (`get` / `search` /
 * `latest`). The default shape drops storage/pipeline internals and redundant
 * title variants so agents spend fewer tokens; `--full` returns the complete
 * unprojected payload the CLI received.
 */

/** The live `/v1/releases/:id` payload carries fields not on the stale
 *  `ReleaseWithSource` interface (org, sourceType, media). Read them
 *  defensively. */
type RawReleaseDetail = ReleaseWithSource & {
  org?: { slug: string; name: string } | null;
  sourceType?: string | null;
  media?: MediaItem[] | null;
};

function nullIfEmpty(s: string | null | undefined): string | null {
  return s?.trim() || null;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function slimReleaseDetail(
  rel: ReleaseWithSource,
  opts: { contentChars: number; contentTokens: number; full: boolean },
): unknown {
  if (opts.full) {
    return { ...rel, contentChars: opts.contentChars, contentTokens: opts.contentTokens };
  }
  const r = rel as RawReleaseDetail;
  const excerpt = cleanExcerpt(r.content);
  // `media[]` is user-facing content (carries the R2-mirrored `r2Url`), not a
  // storage/pipeline internal — surface it in the slim shape so callers can
  // verify media presence (e.g. "did this mirror to R2?") without dropping to
  // `--full` or hitting `GET /v1/releases/:id` directly. #303
  const media = Array.isArray(r.media) ? r.media : [];
  // Hint that the full body was projected to an excerpt so callers know `--full`
  // (or `releases release get`) exists. Only when there's content to truncate.
  const contentTruncated = (r.content?.length ?? 0) > 0 ? true : undefined;
  return omitUndefined({
    id: r.id,
    version: nullIfEmpty(r.version) ?? undefined,
    title: r.title,
    summary: nullIfEmpty(r.summary),
    excerpt: excerpt || undefined,
    contentTruncated,
    url: r.url ?? undefined,
    publishedAt: r.publishedAt,
    source: { slug: r.sourceSlug ?? "", name: r.sourceName ?? "" },
    org: r.org ? { slug: r.org.slug, name: r.org.name } : undefined,
    media: media.length > 0 ? media : undefined,
    // `?? undefined` not `|| undefined` — a zero-length body is a real metric
    // (empty release), and `get` always carries a content field. Keeping 0 also
    // matches slimLatest below.
    contentChars: opts.contentChars ?? undefined,
    contentTokens: opts.contentTokens ?? undefined,
    // AI-scored importance passes through verbatim, including `null` for an
    // unscored release — `?? null` (not `?? undefined`) so `omitUndefined`
    // never drops the field. Machine consumers get the raw score; only the
    // TTY table applies the ≥4 render threshold.
    importance: r.importance ?? null,
  });
}

export function slimSearchHit(hit: SearchReleaseHit, full: boolean): unknown {
  if (full) return hit;
  const excerpt = cleanExcerpt(hit.content) || cleanExcerpt(hit.summary);
  // `number | undefined`: keep 0 (present-but-empty body) but omit entirely when
  // the hit carries no content field (size unknown, not zero).
  const chars = hit.content?.length;
  return omitUndefined({
    id: hit.id,
    version: nullIfEmpty(hit.version) ?? undefined,
    title: hit.title,
    summary: nullIfEmpty(hit.summary),
    excerpt: excerpt || undefined,
    publishedAt: hit.publishedAt,
    source: { slug: hit.sourceSlug, name: hit.sourceName },
    org: hit.orgSlug ? { slug: hit.orgSlug, name: hit.orgName ?? undefined } : undefined,
    contentChars: chars,
    // Verbatim passthrough, including `null` for unscored — same norm as
    // slimReleaseDetail / slimLatest. Older servers omit the key and we still
    // emit `null` so machine consumers get a stable field. Wire field from
    // monorepo #2135 (`@buildinternet/releases-api-types` ≥ 0.48.0).
    importance: hit.importance ?? null,
  });
}

export function slimLatest(row: LatestRelease, full: boolean): unknown {
  if (full) return row;
  return omitUndefined({
    id: row.id,
    version: nullIfEmpty(row.version) ?? undefined,
    title: row.title,
    summary: nullIfEmpty(row.summary),
    publishedAt: row.publishedAt,
    source: { slug: row.sourceSlug, name: row.sourceName },
    contentChars: row.contentChars ?? undefined,
    contentTokens: row.contentTokens ?? undefined,
    // Verbatim passthrough, including `null` for unscored — see slimReleaseDetail.
    importance: row.importance ?? null,
  });
}
