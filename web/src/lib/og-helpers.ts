/**
 * Pure helpers used by the Open Graph image template. Split from og.tsx
 * so they can be unit-tested without pulling in next/og (which requires
 * the Next.js runtime to load).
 */

export function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}

export function stripMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      // Unwrap inline code to its contents rather than deleting the span:
      // dropping it wholesale turned "(`none`/`minor`/`major`)" into "( / / )"
      // and "the `search` tool" into "the tool".
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Heading/blockquote markers are only markers at the start of a line.
      .replace(/^[ \t]*[#>]+[ \t]*/gm, "")
      // `_` is deliberately not stripped: in changelog prose it is far more
      // often an identifier character (`whats_changed`) than an emphasis
      // marker, and unwrapped code spans now expose those identifiers here.
      .replace(/[*~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Junk-media detection (avatars, favicons, data URIs) lives in
// `@releases/rendering/media-filter` so the ingest R2-upload pre-filter and the
// OG hero-image picker share one marker list and can't drift apart.
export { SMALL_MEDIA_MARKERS, isJunkMediaUrl } from "@releases/rendering/media-filter";

export const HERO_MIN_BYTES = 50_000;
export const HERO_MAX_BYTES = 3_000_000;

export function isHeroImageResponse(contentType: string, byteLength: number): boolean {
  if (!/^image\/(png|jpeg|jpg|webp)/i.test(contentType)) return false;
  if (byteLength < HERO_MIN_BYTES || byteLength > HERO_MAX_BYTES) return false;
  return true;
}
