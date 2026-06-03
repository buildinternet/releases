/**
 * Entity notice — a small curator-set note attached to an org, product, or
 * source. Stored as a JSON sub-object under the entity's `metadata` column at
 * the `notice` key. Pure / runtime-neutral (no zod, no DB) so the API worker,
 * the MCP worker, and the web component can all share these helpers. The zod
 * validation schema lives in `@buildinternet/releases-api-types` (`NoticeSchema`)
 * and must stay structurally in sync with `Notice` below.
 */

export interface Notice {
  /** Short human message. ≤280 chars (enforced by NoticeSchema on write). */
  message: string;
  /** Optional CTA label for the link. */
  linkText?: string;
  /** Internal registry coordinate: "org" or "org/slug". Mutually exclusive with href. */
  coordinate?: string;
  /** External absolute URL. Mutually exclusive with coordinate. */
  href?: string;
}

const COORDINATE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A notice coordinate is 1 or 2 URL-safe slug segments ("org" or "org/slug"):
 * no scheme, no leading/trailing slash. Not resolved against the DB — curators
 * may point at an entity before it exists.
 */
export function isValidNoticeCoordinate(input: string): boolean {
  if (!input || input.startsWith("/") || input.endsWith("/")) return false;
  const parts = input.split("/");
  if (parts.length > 2) return false;
  return parts.every((p) => COORDINATE_SEGMENT.test(p));
}

/**
 * Read the `notice` sub-object out of an entity's `metadata` JSON. Fail-safe:
 * malformed JSON or a malformed notice yields null, never throws.
 */
export function parseNotice(metadata: string | null | undefined): Notice | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = (parsed as Record<string, unknown>).notice;
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.message !== "string" || n.message.length === 0) return null;
  const out: Notice = { message: n.message };
  if (typeof n.linkText === "string") out.linkText = n.linkText;
  if (typeof n.coordinate === "string") out.coordinate = n.coordinate;
  if (typeof n.href === "string") out.href = n.href;
  return out;
}

/**
 * Set or clear the `notice` key inside an entity's `metadata` JSON, preserving
 * every other key. Pass null to clear. Returns the serialized metadata string.
 */
export function setNoticeInMetadata(
  metadata: string | null | undefined,
  notice: Notice | null,
): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === "object" && parsed !== null) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  if (notice === null) {
    delete base.notice;
  } else {
    base.notice = notice;
  }
  return JSON.stringify(base);
}

/**
 * Compact one-line pointer for CLI / MCP / agent surfaces: the message plus the
 * coordinate (or external URL) to follow.
 */
export function formatNoticePointer(notice: Notice): string {
  const target = notice.coordinate ?? notice.href;
  return target ? `${notice.message} → ${target}` : notice.message;
}
