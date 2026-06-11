"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readableTextColor, type StoredSiteNotice } from "@buildinternet/releases-core/site-notice";

const DISMISS_KEY = "releases:site-notice-dismissed";

/**
 * Renders the site notice as a thin top banner (variant "banner") or a home
 * card (variant "card"). The background is the notice's hex color; the text
 * color is auto-derived for contrast. When `dismissible`, a close button hides
 * it and persists the current `updatedAt` in localStorage, so editing/publishing
 * a fresh notice re-shows it to everyone.
 */
export function SiteNoticeView({
  notice,
  variant,
}: {
  notice: StoredSiteNotice;
  variant: "banner" | "card";
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!notice.dismissible) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === notice.updatedAt) setDismissed(true);
    } catch {
      /* localStorage blocked — show the notice */
    }
  }, [notice.dismissible, notice.updatedAt]);

  if (dismissed) return null;

  const fg = readableTextColor(notice.color);
  // Defense-in-depth: only render a link for a root-relative path (not a
  // protocol-relative "//host") or an http(s) URL. The API schema + admin form
  // already validate href, but the live preview renders unvalidated form state,
  // so never trust a value with an unexpected scheme (javascript:, data:, …).
  const safeHref =
    notice.href &&
    ((notice.href.startsWith("/") && !notice.href.startsWith("//")) ||
      /^https?:\/\//i.test(notice.href))
      ? notice.href
      : null;
  const link = safeHref ? (
    safeHref.startsWith("/") ? (
      <Link
        href={safeHref}
        className="font-semibold underline underline-offset-2 hover:no-underline"
      >
        {notice.linkText ?? safeHref}
      </Link>
    ) : (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline underline-offset-2 hover:no-underline"
      >
        {notice.linkText ?? safeHref}
      </a>
    )
  ) : null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, notice.updatedAt);
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  const isBanner = variant === "banner";
  return (
    <div
      role="status"
      style={{ backgroundColor: notice.color, color: fg }}
      className={
        isBanner
          ? "relative flex w-full items-center justify-center gap-2 px-4 py-1.5 text-center text-[13px]"
          : "mx-auto flex max-w-5xl items-center justify-between gap-3 rounded-md px-4 py-3 text-sm"
      }
    >
      <span>
        {notice.message}
        {link && <> {link}</>}
      </span>
      {notice.dismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notice"
          style={{ color: fg }}
          className={`shrink-0 opacity-70 transition hover:opacity-100 ${isBanner ? "absolute right-3" : ""}`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      )}
    </div>
  );
}
