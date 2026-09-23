"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteReleaseAction, suppressReleaseAction } from "@/app/actions/release-admin";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type Mode = "closed" | "menu" | "suppress" | "delete";

export function ReleaseAdminMenu({
  releaseId,
  redirectTo,
  rawJsonHref,
}: {
  releaseId: string;
  redirectTo?: string;
  rawJsonHref: string;
}) {
  const [mode, setMode] = useState<Mode>("closed");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { copied, copy } = useCopyToClipboard(1200);

  function closeMenu() {
    setMode("closed");
    setError(null);
    setReason("");
  }

  useEffect(() => {
    if (mode === "closed") return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mode]);

  function handleSuppress() {
    startTransition(async () => {
      setError(null);
      const res = await suppressReleaseAction({
        id: releaseId,
        reason: reason || undefined,
        redirectTo,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      closeMenu();
      if (res.redirectTo) router.push(res.redirectTo);
      else router.refresh();
    });
  }

  function handleDelete() {
    startTransition(async () => {
      setError(null);
      const res = await deleteReleaseAction({ id: releaseId, redirectTo });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      closeMenu();
      if (res.redirectTo) router.push(res.redirectTo);
      else router.refresh();
    });
  }

  const open = mode !== "closed";

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => (open ? closeMenu() : setMode("menu"))}
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
          className="absolute right-0 top-full mt-1 z-20 w-64 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          {mode === "menu" && (
            <div className="py-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => setMode("suppress")}
                className="w-full text-left px-3 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900 text-stone-700 dark:text-stone-200"
              >
                Suppress release…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setMode("delete")}
                className="w-full text-left px-3 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900 text-red-600 dark:text-red-400"
              >
                Delete release…
              </button>
              <div className="my-1 border-t border-stone-200 dark:border-stone-800" />
              <button
                type="button"
                role="menuitem"
                onClick={() => copy(releaseId)}
                className="w-full text-left px-3 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900 text-stone-700 dark:text-stone-200"
              >
                {copied ? "Copied!" : "Copy release ID"}
              </button>
              <a
                role="menuitem"
                href={rawJsonHref}
                target="_blank"
                rel="noreferrer"
                className="block w-full text-left px-3 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900 text-stone-700 dark:text-stone-200"
              >
                View raw JSON ↗
              </a>
            </div>
          )}
          {mode === "suppress" && (
            <div className="p-3 space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Suppress release</div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Hides the row from public read paths without deleting it.
              </p>
              <label className="block text-[11px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
                Reason (optional)
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. spam, duplicate, marketing"
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 text-[13px]"
                autoFocus
              />
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleSuppress}
                  disabled={pending}
                  className="flex-1 px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
                >
                  {pending ? "Suppressing…" : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("menu")}
                  disabled={pending}
                  className="px-2 py-1 rounded text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {mode === "delete" && (
            <div className="p-3 space-y-2">
              <div className="font-medium text-red-600 dark:text-red-400">Delete release?</div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Hard-deletes the row. Prefer Suppress unless the release is truly junk.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={pending}
                  className="flex-1 px-2 py-1 rounded border border-red-300 dark:border-red-900 bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 text-red-700 dark:text-red-300 disabled:opacity-50"
                >
                  {pending ? "Deleting…" : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("menu")}
                  disabled={pending}
                  className="px-2 py-1 rounded text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="px-3 py-2 border-t border-stone-200 dark:border-stone-800 text-[12px] text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
