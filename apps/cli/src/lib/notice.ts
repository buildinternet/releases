/**
 * Entity-notice helpers (org / product / source).
 *
 * A "notice" is a small curator-set note attached to an org, product, or source
 * with an optional pointer — either a registry coordinate ("org/slug") or an
 * external URL.
 */

import type { Notice } from "@buildinternet/releases-core/notice";
export type { Notice };

/**
 * Extend any entity type at runtime to carry the optional `notice` field.
 * Used by command files that cast narrowed API response shapes to include notice.
 */
export type EntityWithNotice<T> = T & { notice?: Notice | null };

// ── Client-side validation caps (server is authoritative) ────────────────────

export const NOTICE_MESSAGE_MAX = 280;
export const NOTICE_LINK_TEXT_MAX = 60;
export const NOTICE_HREF_MAX = 500;

/** Segments that form a valid registry coordinate, e.g. "org" or "org/slug". */
const COORD_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Return true if `value` looks like an absolute http(s) URL.
 * Keeps the check deliberately lenient — the server validates the canonical
 * form; we just route the value to the right field.
 */
export function isAbsoluteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Validate a registry coordinate: 1–2 URL-safe slug segments separated by a
 * single slash (no leading/trailing/doubled slashes, no URL scheme).
 * Returns an error string, or null when valid.
 */
export function validateCoordinate(value: string): string | null {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return `"${value}" looks like a URL — drop the scheme or it will be sent as a coordinate`;
  }
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 2) {
    return `coordinate must be 1–2 slash-separated segments (e.g. "cognition" or "cognition/devin"), got: "${value}"`;
  }
  for (const part of parts) {
    if (!part) {
      return `coordinate must not have leading, trailing, or doubled slashes: "${value}"`;
    }
    if (!COORD_SEGMENT_RE.test(part)) {
      return `coordinate segments must only contain letters, digits, dots, underscores, and dashes: "${value}"`;
    }
  }
  return null;
}

/**
 * Build the `{ notice }` payload to send in a PATCH body.
 *
 * - `--clear-notice` sends `{ notice: null }`.
 * - `--notice <message>` (with optional `--notice-link` / `--notice-link-text`)
 *   builds the object shape.
 *
 * Returns `null` when neither clear nor set is requested (caller should skip
 * adding notice to the patch body).
 *
 * Exits the process with an error on invalid input — mirrors the rest of the
 * CLI's fast-fail validation pattern.
 */
export function buildNoticePatch(
  opts: {
    notice?: string;
    noticeLink?: string;
    noticeLinkText?: string;
    clearNotice?: boolean;
  },
  logger: { error: (msg: string) => void },
): { notice: Notice | null } | null {
  const hasClear = !!opts.clearNotice;
  const hasSet = !!opts.notice;

  if (!hasClear && !hasSet) return null;

  if (hasClear && hasSet) {
    logger.error("--clear-notice and --notice cannot be used together");
    process.exit(1);
  }

  if (hasClear) return { notice: null };

  // hasClear is false and hasSet is true
  const message = opts.notice!;

  if (message.length > NOTICE_MESSAGE_MAX) {
    logger.error(
      `--notice message is too long (${message.length} chars; max ${NOTICE_MESSAGE_MAX})`,
    );
    process.exit(1);
  }

  if (opts.noticeLinkText && opts.noticeLinkText.length > NOTICE_LINK_TEXT_MAX) {
    logger.error(
      `--notice-link-text is too long (${opts.noticeLinkText.length} chars; max ${NOTICE_LINK_TEXT_MAX})`,
    );
    process.exit(1);
  }

  const noticeObj: Notice = { message };

  if (opts.noticeLinkText) {
    noticeObj.linkText = opts.noticeLinkText;
  }

  if (opts.noticeLink) {
    if (isAbsoluteUrl(opts.noticeLink)) {
      if (opts.noticeLink.length > NOTICE_HREF_MAX) {
        logger.error(
          `--notice-link URL is too long (${opts.noticeLink.length} chars; max ${NOTICE_HREF_MAX})`,
        );
        process.exit(1);
      }
      noticeObj.href = opts.noticeLink;
    } else {
      const err = validateCoordinate(opts.noticeLink);
      if (err) {
        logger.error(`--notice-link: ${err}`);
        process.exit(1);
      }
      noticeObj.coordinate = opts.noticeLink;
    }
  }

  return { notice: noticeObj };
}

/**
 * Format a notice for human-readable terminal output.
 * Returns a string like `Notice: Message → coordinate-or-href`
 * (the pointer is omitted when absent).
 */
export function formatNotice(notice: Notice): string {
  const pointer = notice.coordinate ?? notice.href ?? null;
  return pointer ? `Notice: ${notice.message} → ${pointer}` : `Notice: ${notice.message}`;
}
