"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSourceMetadataAction, promoteSourceAction } from "@/app/actions/source-admin";

type Depth = "full" | "summary-only" | null;

export function SourceAdminMenu({
  orgSlug,
  sourceSlug,
  marketingFilter,
  marketingFilterHint,
  feedContentDepth,
  discovery,
  isHidden,
}: {
  orgSlug: string;
  sourceSlug: string;
  marketingFilter: boolean;
  marketingFilterHint: string | null;
  feedContentDepth: Depth;
  discovery?: string;
  isHidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(marketingFilterHint ?? "");
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

  // Keep the hint field in sync when the source data refreshes.
  useEffect(() => {
    setHint(marketingFilterHint ?? "");
  }, [marketingFilterHint]);

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

  const canPromote = discovery === "on_demand" && isHidden;
  const depthBtn = (label: string, value: Depth) => (
    <button
      type="button"
      key={label}
      onClick={() =>
        run(() =>
          setSourceMetadataAction({ orgSlug, sourceSlug, patch: { feedContentDepth: value } }),
        )
      }
      disabled={pending}
      aria-pressed={feedContentDepth === value}
      className={`flex-1 px-2 py-1 rounded border text-[12px] disabled:opacity-50 ${
        feedContentDepth === value
          ? "border-stone-500 dark:border-stone-400 bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100"
          : "border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
      }`}
    >
      {label}
    </button>
  );

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
        Admin
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-80 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Marketing classifier
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Runs each new feed item through the Haiku marketing classifier on ingest; items
                judged marketing are suppressed.
              </p>
              <button
                type="button"
                onClick={() =>
                  run(() =>
                    setSourceMetadataAction({
                      orgSlug,
                      sourceSlug,
                      patch: { marketingFilter: !marketingFilter },
                    }),
                  )
                }
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : marketingFilter ? "Disable classifier" : "Enable classifier"}
              </button>
              {marketingFilter && (
                <div className="space-y-1">
                  <textarea
                    value={hint}
                    onChange={(e) => setHint(e.target.value)}
                    rows={2}
                    placeholder="Optional hint for the classifier prompt…"
                    className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      run(() =>
                        setSourceMetadataAction({
                          orgSlug,
                          sourceSlug,
                          patch: { marketingFilterHint: hint.trim() || null },
                        }),
                      )
                    }
                    disabled={pending}
                    className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
                  >
                    {pending ? "Saving…" : "Save hint"}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Feed content depth
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Marks summary-only feeds for enrichment. Enrichment also requires the API
                worker&apos;s FEED_ENRICH_ENABLED (on in prod) and only acts on summary-only.
              </p>
              <div className="flex gap-1.5">
                {depthBtn("Auto", null)}
                {depthBtn("Full", "full")}
                {depthBtn("Summary-only", "summary-only")}
              </div>
            </div>

            {canPromote && (
              <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
                <div className="font-medium text-stone-700 dark:text-stone-200">Promote source</div>
                <p className="text-[12px] text-stone-500 dark:text-stone-400">
                  Un-hide this on-demand source so it appears in listings, sitemap, and AI features.
                </p>
                <button
                  type="button"
                  onClick={() => run(() => promoteSourceAction({ orgSlug, sourceSlug }))}
                  disabled={pending}
                  className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
                >
                  {pending ? "Promoting…" : "Promote source"}
                </button>
              </div>
            )}

            <div className="space-y-1 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">State</div>
              <dl className="text-[12px] text-stone-500 dark:text-stone-400 space-y-0.5">
                <div className="flex justify-between gap-2">
                  <dt>Discovery</dt>
                  <dd className="font-mono">{discovery ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Hidden</dt>
                  <dd className="font-mono">{isHidden ? "true" : "false"}</dd>
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
