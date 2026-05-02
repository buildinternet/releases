"use client";

import { useState, useTransition } from "react";
import { promoteSourceAction } from "@/app/actions/promote-source";

export function PromoteSourceButton({
  orgSlug,
  sourceSlug,
}: {
  orgSlug: string;
  sourceSlug: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await promoteSourceAction({ orgSlug, sourceSlug });
            if (!res.ok) setError(res.error);
          })
        }
        className="text-[11px] px-2 py-0.5 rounded font-medium uppercase tracking-wider border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
        title="Un-hide this source so it appears in listings, sitemap, and AI features."
      >
        {pending ? "Promoting…" : "Promote source"}
      </button>
      {error && <span className="text-[12px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
