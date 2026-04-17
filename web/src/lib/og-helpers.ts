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
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * URL substrings that indicate a media item is a tiny thumbnail (typically
 * an author avatar baked into a changelog page) rather than a hero image
 * worth promoting into the OG card.
 */
export const SMALL_MEDIA_MARKERS: readonly string[] = [
  "c_fill,w_44",
  "c_fill,w_48",
  "c_fill,w_64",
  "c_fill,w_96",
  "/avatar/",
  "?s=32",
  "?s=44",
  "?s=48",
  "?s=64",
  "&s=32",
  "&s=44",
  "&s=48",
  "&s=64",
];

export function isJunkMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return SMALL_MEDIA_MARKERS.some((marker) => url.includes(marker));
}

export const HERO_MIN_BYTES = 50_000;
export const HERO_MAX_BYTES = 3_000_000;

export function isHeroImageResponse(contentType: string, byteLength: number): boolean {
  if (!/^image\/(png|jpeg|jpg|webp)/i.test(contentType)) return false;
  if (byteLength < HERO_MIN_BYTES || byteLength > HERO_MAX_BYTES) return false;
  return true;
}
