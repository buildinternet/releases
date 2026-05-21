"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrgHiddenAction, setOrgAutoGenerateContentAction } from "@/app/actions/org-admin";

export function OrgAdminMenu({
  orgSlug,
  isHidden,
  autoGenerateContent,
  discovery,
  fetchPaused,
}: {
  orgSlug: string;
  isHidden: boolean;
  autoGenerateContent: boolean;
  discovery?: string;
  fetchPaused?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

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

  const onDemand = discovery === "on_demand";
  const buttonLabel = isHidden ? "Admin · Hidden" : autoGenerateContent ? "Admin · AI" : "Admin";

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-[11px] px-2 py-0.5 rounded font-medium uppercase tracking-wider border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
        title="Local-dev admin actions"
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-80 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-3">
            <div className="space-y-2">
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
