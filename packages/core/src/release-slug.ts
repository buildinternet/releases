import { toSlug } from "./slug";

/**
 * Friendly release URLs (Zendesk-style): `/release/rel_<id>-<slug>`.
 *
 * The `rel_` ID is the only routing key; the slug is derived from the
 * current title at request time and is purely decorative. nanoid's default
 * alphabet includes `-` and `_`, so the segment is parsed positionally
 * (`rel_` + exactly 21 chars), never by splitting on a delimiter.
 */

const MAX_SLUG_LENGTH = 80;

/** `rel_` + 21-char nanoid body, then optionally `-<slug>`. */
const RELEASE_SEGMENT = /^(rel_[A-Za-z0-9_-]{21})(?:-(.+))?$/;

export interface ReleaseSlugInput {
  titleShort?: string | null;
  titleGenerated?: string | null;
  title?: string | null;
  version?: string | null;
}

function truncateOnHyphen(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH + 1);
  const boundary = cut.lastIndexOf("-");
  const truncated = boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, MAX_SLUG_LENGTH);
  return truncated.replace(/-+$/, "");
}

/**
 * Slug for a release's friendly URL, from the best available title.
 * Returns `""` when no candidate yields a usable slug — callers emit the
 * bare-ID path in that case.
 */
export function releaseSlug(r: ReleaseSlugInput): string {
  for (const candidate of [r.titleShort, r.titleGenerated, r.title, r.version]) {
    if (!candidate) continue;
    const slug = toSlug(candidate);
    if (slug) return truncateOnHyphen(slug);
  }
  return "";
}

/** Canonical web path for a release: `/release/<id>` or `/release/<id>-<slug>`. */
export function releasePath(r: { id: string } & ReleaseSlugInput): string {
  const slug = releaseSlug(r);
  return slug ? `/release/${r.id}-${slug}` : `/release/${r.id}`;
}

/**
 * Absolute web origin for a release's `webUrl`, from a `WEB_BASE_URL` env-ish
 * bag. Falls back to the prod origin (and strips trailing slashes) so a caller
 * without the var still emits a well-formed URL. Shared by the API + MCP
 * workers so the fallback origin lives in exactly one place.
 */
export function releaseWebBase(env: { WEB_BASE_URL?: string }): string {
  return (env.WEB_BASE_URL ?? "https://releases.sh").replace(/\/+$/, "");
}

/**
 * Absolute canonical web URL for a release: `<base><releasePath(r)>`. `base`
 * comes from {@link releaseWebBase}; `releasePath` supplies the leading slash.
 */
export function releaseWebUrl(base: string, r: { id: string } & ReleaseSlugInput): string {
  return `${base}${releasePath(r)}`;
}

/**
 * Positional parse of a `/release/:id` path segment. Extracts `rel_` + 21
 * chars as the ID; anything after a following `-` is decorative slug.
 * Input that doesn't match the shape passes through as the ID so existing
 * lookup/404 behavior is unchanged.
 */
export function parseReleaseParam(segment: string): { id: string; slug: string | null } {
  const m = RELEASE_SEGMENT.exec(segment.trim());
  if (!m) return { id: segment.trim(), slug: null };
  return { id: m[1], slug: m[2] ?? null };
}
