/**
 * Portable media URL handling.
 *
 * Content stores media references as `/_media/{r2Key}` — a stable,
 * domain-free prefix. At read time, hydrate to the current media origin.
 * This avoids baking domains into stored content and eliminates the need
 * for migrations when the serving domain changes.
 */

/** Prefix written into release content at fetch/ingest time. */
export const MEDIA_PREFIX = "/_media/";

const LEGACY_ABSOLUTE = /https?:\/\/api\.releases\.sh\/v1\/media\//g;
const LEGACY_RELATIVE = /\/v1\/media\//g;

/**
 * Replace portable `/_media/` prefixes (and legacy `/v1/media/` references)
 * in content with the given media origin URL.
 *
 * Returns the original string unchanged if mediaOrigin is empty or
 * content contains no media references.
 */
export function hydrateMediaUrls(content: string, mediaOrigin: string): string {
  if (!mediaOrigin || !content) return content;
  if (!content.includes("/_media/") && !content.includes("/v1/media/")) return content;

  const origin = mediaOrigin.endsWith("/") ? mediaOrigin.slice(0, -1) : mediaOrigin;
  const replacement = `${origin}/`;

  return content
    .replaceAll(MEDIA_PREFIX, replacement)
    .replace(LEGACY_ABSOLUTE, replacement)
    .replace(LEGACY_RELATIVE, replacement);
}

/** Build an absolute media URL from an R2 key, or undefined if no key. */
export function resolveR2Url(r2Key: string | undefined | null, mediaOrigin: string): string | undefined {
  if (!r2Key) return undefined;
  return `${mediaOrigin}/${r2Key}`;
}
