"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Notice } from "@buildinternet/releases-core/notice";
import {
  setOrgHiddenAction,
  setOrgAutoGenerateContentAction,
  setOrgFeaturedAction,
  setOrgNoticeAction,
  renameOrgAction,
} from "@/app/actions/org-admin";
import { NoticeForm } from "@/components/notice-form";

export function OrgAdminMenu({
  orgSlug,
  name,
  isHidden,
  autoGenerateContent,
  featured,
  discovery,
  fetchPaused,
  notice,
  variant = "badge",
  align = "left",
}: {
  orgSlug: string;
  name: string;
  isHidden: boolean;
  autoGenerateContent: boolean;
  featured: boolean;
  discovery?: string;
  fetchPaused?: boolean;
  notice?: Notice | null;
  /** `subtle` — muted text trigger for inline header actions. */
  variant?: "badge" | "subtle";
  /** Dropdown horizontal anchor. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(name);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const displayNameId = useId();

  function close() {
    setOpen(false);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      setError(null);
      try {
        const res = await action();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        close();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  // Keep the name field in sync when the org data refreshes.
  useEffect(() => {
    setNameDraft(name);
  }, [name]);

  const trimmed = nameDraft.trim();
  const canRename = trimmed.length > 0 && trimmed !== name.trim();

  const onDemand = discovery === "on_demand";
  const statusSuffix = isHidden ? "Hidden" : autoGenerateContent ? "AI" : null;
  const triggerClass =
    variant === "subtle"
      ? "inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-200"
      : "text-[11px] px-2 py-0.5 rounded font-medium uppercase tracking-wider border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200";

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClass}
        title="Local-dev admin actions"
      >
        Admin
        {statusSuffix && (
          <span
            className={
              variant === "subtle"
                ? "text-stone-300 dark:text-stone-600"
                : "font-normal normal-case tracking-normal"
            }
          >
            · {statusSuffix}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 z-20 w-80 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden ${align === "right" ? "right-0" : "left-0"}`}
        >
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <label
                htmlFor={displayNameId}
                className="block font-medium text-stone-700 dark:text-stone-200"
              >
                Display name
              </label>
              <input
                id={displayNameId}
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[13px]"
              />
              <button
                type="button"
                onClick={() => run(() => renameOrgAction({ slug: orgSlug, name: trimmed }))}
                disabled={pending || !canRename}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Renames the display name only — slug and URL stay the same.
              </p>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">Listings</div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                {isHidden
                  ? "Hidden from the homepage ticker and the org directory. Still reachable by direct link, search, and sitemap."
                  : "Visible in the homepage ticker and the org directory. Hiding keeps direct link, search, and sitemap."}
              </p>
              <button
                type="button"
                onClick={() => run(() => setOrgHiddenAction({ slug: orgSlug, hidden: !isHidden }))}
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : isHidden ? "Unhide from listings" : "Hide from listings"}
              </button>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Featured on home page
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                {featured
                  ? "Shown in the curated org rail on the home page. The full A–Z list lives at /catalog regardless."
                  : "Not featured. The home page shows a curated rail; un-featured orgs still appear in the full catalog and search."}
              </p>
              <button
                type="button"
                onClick={() =>
                  run(() => setOrgFeaturedAction({ slug: orgSlug, featured: !featured }))
                }
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : featured ? "Remove from featured" : "Add to featured"}
              </button>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Auto-generate AI content
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Generates org overviews and per-release AI summaries on ingest.
                {onDemand
                  ? " Note: on-demand orgs are skipped for overviews regardless of this flag (summaries still run)."
                  : ""}
              </p>
              <button
                type="button"
                onClick={() =>
                  run(() =>
                    setOrgAutoGenerateContentAction({
                      slug: orgSlug,
                      enabled: !autoGenerateContent,
                    }),
                  )
                }
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending
                  ? "Saving…"
                  : autoGenerateContent
                    ? "Disable AI content"
                    : "Enable AI content"}
              </button>
            </div>

            <NoticeForm
              notice={notice}
              pending={pending}
              onSave={(n) => run(() => setOrgNoticeAction({ slug: orgSlug, notice: n }))}
              onClear={() => run(() => setOrgNoticeAction({ slug: orgSlug, notice: null }))}
            />

            <div className="space-y-1 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">State</div>
              <dl className="text-[12px] text-stone-500 dark:text-stone-400 space-y-0.5">
                <div className="flex justify-between gap-2">
                  <dt>Discovery</dt>
                  <dd className="font-mono">{discovery ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Fetch paused</dt>
                  <dd className="font-mono">
                    {fetchPaused === undefined ? "—" : fetchPaused ? "true" : "false"}
                  </dd>
                </div>
              </dl>
            </div>

            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
