"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrgHiddenAction } from "@/app/actions/org-admin";

export function OrgAdminMenu({ orgSlug, isHidden }: { orgSlug: string; isHidden: boolean }) {
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

  function handleToggle() {
    startTransition(async () => {
      setError(null);
      const res = await setOrgHiddenAction({ slug: orgSlug, hidden: !isHidden });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      close();
      router.refresh();
    });
  }

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
        {isHidden ? "Admin · Hidden" : "Admin"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-72 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-2">
            <div className="font-medium text-stone-700 dark:text-stone-200">
              {isHidden ? "Org hidden from listings" : "Feature visibility"}
            </div>
            <p className="text-[12px] text-stone-500 dark:text-stone-400">
              {isHidden
                ? "Excluded from the homepage ticker and the org directory. Still reachable by direct link, search, and sitemap."
                : "Hides this org from the homepage ticker and the org directory table. It stays reachable by direct link, search, and sitemap."}
            </p>
            <button
              type="button"
              onClick={handleToggle}
              disabled={pending}
              className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
            >
              {pending ? "Saving…" : isHidden ? "Unhide from listings" : "Hide from listings"}
            </button>
            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
