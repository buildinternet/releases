/**
 * Content-identity dedup for ingest.
 *
 * Scrape changelogs (OpenAI API, Claude Platform, …) re-emit the same entry
 * under a reworded title and a new `#anchor`. `UNIQUE(source_id, url)` misses
 * that, and title dedup misses it too — the title is what changed. A
 * normalized hash of the body, matched only against the same source on the
 * same calendar day, catches the duplicate without collapsing a backport or
 * a sibling package that happens to share wording.
 *
 * The hash itself is computed by the caller (`sha256` of
 * {@link normalizeReleaseBody}) so this module stays runtime-neutral.
 */

/** Bodies shorter than this (after normalization) are too generic to dedup. */
export const MIN_NORMALIZED_BODY_CHARS = 80;

/**
 * Calendar day (`YYYY-MM-DD`, UTC) for a stored or incoming timestamp.
 * Date-only strings stay on that day; datetimes convert to UTC. Unparseable
 * values return null — a row with no day never matches.
 */
export function publishedDay(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (dateOnly) return dateOnly[1];
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Body text with the parts a re-extract rewrites stripped out: a leading
 * heading (the reworded title), markdown links/images, bare URLs, and
 * punctuation. What remains is the wording a reader would call "the same
 * notes".
 */
export function normalizeReleaseBody(content: string, title?: string | null): string {
  const withoutTitle = stripLeadingTitle(content, title);
  const text = withoutTitle
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, " $1 ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripLeadingTitle(content: string, title?: string | null): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return content;
  const first = lines[i]!.trim();
  const heading = /^#{1,6}\s+(.*)$/.exec(first);
  const firstText = (heading ? heading[1] : first).trim();
  const titleNorm = title ? norm(title) : "";
  // A leading heading is the anchor title — drop it even when the wording
  // changed. A plain first line is dropped only when it is the title.
  if (heading || (titleNorm && norm(firstText) === titleNorm)) {
    lines.splice(i, 1);
    return lines.join("\n");
  }
  return content;
}

/** Package + version token parsed from a version field or a title. */
export interface VersionIdentity {
  /** Lowercased semver token, prerelease tag included (`1.2.0`, `1.2.0-rc.1`). */
  token: string;
  /** Set when the string names a package (`ollama`, `@sanity/client`). */
  packageName: string | null;
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:[-+][\w.]+)?`;
const PKG_AT_VERSION = new RegExp(`^(@?[\\w.-]+(?:\\/[\\w.-]+)?)@v?(${SEMVER})$`, "i");
const PKG_PREFIX_VERSION = new RegExp(`^([a-z0-9][a-z0-9._-]*)\\s+v?(${SEMVER})$`);
const BARE_VERSION = new RegExp(`^v?(${SEMVER})$`, "i");
const EMBEDDED_VERSION = new RegExp(`\\b(?:v)?(${SEMVER})\\b`, "i");

/**
 * Identity used to decide whether two rows are the same release or two
 * packages / version lines. Package names come only from `name@version` or
 * a lowercase package token in front of a version, so a reworded prose title
 * ("Released 1.2.0" vs "Shipped 1.2.0") does not look like two packages.
 */
export function versionIdentity(
  version?: string | null,
  title?: string | null,
): VersionIdentity | null {
  const fromVersion = version ? identityFrom(version.trim()) : null;
  const fromTitle = title ? identityFrom(title.trim()) : null;
  // A bare `version` column (`0.12.0`) hides the package named in the title
  // (`ollama-python 0.12.0`). Keep the version token and fill the package
  // from the title when that title names the same token.
  if (fromVersion) {
    if (
      !fromVersion.packageName &&
      fromTitle?.packageName &&
      fromTitle.token === fromVersion.token
    ) {
      return { token: fromVersion.token, packageName: fromTitle.packageName };
    }
    return fromVersion;
  }
  return fromTitle;
}

function identityFrom(input: string): VersionIdentity | null {
  if (!input) return null;
  const at = PKG_AT_VERSION.exec(input);
  if (at) return { packageName: at[1]!.toLowerCase(), token: at[2]!.toLowerCase() };
  const prefixed = PKG_PREFIX_VERSION.exec(input);
  if (prefixed)
    return { packageName: prefixed[1]!.toLowerCase(), token: prefixed[2]!.toLowerCase() };
  const bare = BARE_VERSION.exec(input);
  if (bare) return { packageName: null, token: bare[1]!.toLowerCase() };
  const embedded = EMBEDDED_VERSION.exec(input);
  if (embedded) return { packageName: null, token: embedded[1]!.toLowerCase() };
  return null;
}

/**
 * True when content-hash dedup may treat the two rows as the same entry.
 * Different version tokens (stable vs rc, a backport line) and different
 * package names stay distinct so coverage linking can attach them instead.
 * A missing identity on either side is compatible — that's the reworded
 * title with no version, which is the case this dedup exists for.
 */
export function versionsCompatible(a: VersionIdentity | null, b: VersionIdentity | null): boolean {
  if (!a || !b) return true;
  if (a.token !== b.token) return false;
  if (a.packageName && b.packageName && a.packageName !== b.packageName) return false;
  return true;
}

export interface ContentIdentity {
  url?: string | null;
  publishedAt?: string | Date | null;
  /** Precomputed sha256 of {@link normalizeReleaseBody}, or null when too short. */
  bodyHash?: string | null;
  version?: string | null;
  title?: string | null;
}

/**
 * Drop items that repeat an existing same-source entry under a new URL:
 * same normalized body hash, same UTC day, compatible version. An item whose
 * URL is already stored is kept — `UNIQUE(source_id, url)` owns that row.
 * Repeats earlier in the same batch are dropped the same way.
 */
export function dedupeByContentIdentity<T extends ContentIdentity>(
  items: T[],
  existing: readonly ContentIdentity[],
): { kept: T[]; dropped: number } {
  const urls = new Set<string>();
  const keys = new Map<string, Array<VersionIdentity | null>>();
  for (const row of existing) {
    const url = typeof row.url === "string" ? row.url : "";
    if (url) urls.add(url);
    const hash = typeof row.bodyHash === "string" ? row.bodyHash : "";
    const day = publishedDay(row.publishedAt);
    if (!hash || !day) continue;
    const key = `${day}|${hash}`;
    const list = keys.get(key) ?? [];
    list.push(versionIdentity(row.version, row.title));
    keys.set(key, list);
  }

  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const url = item && typeof item.url === "string" ? item.url : "";
    if (url && urls.has(url)) {
      kept.push(item);
      continue;
    }
    const hash = item && typeof item.bodyHash === "string" ? item.bodyHash : "";
    const day = publishedDay(item?.publishedAt);
    if (!hash || !day) {
      kept.push(item);
      continue;
    }
    const key = `${day}|${hash}`;
    const mine = versionIdentity(item.version, item.title);
    const priors = keys.get(key);
    if (priors?.some((prior) => versionsCompatible(prior, mine))) {
      dropped++;
      continue;
    }
    const list = priors ?? [];
    list.push(mine);
    keys.set(key, list);
    kept.push(item);
  }
  return { kept, dropped };
}
