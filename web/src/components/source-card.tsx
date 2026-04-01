import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";
import type { SourceListItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortUrl(url?: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    // GitHub: show owner/repo shorthand instead of full URL
    if (u.hostname === "github.com") {
      return path.replace(/^\//, "") || u.hostname;
    }
    return path && path !== "/" ? u.hostname + path : u.hostname;
  } catch { return null; }
}

export function SourceCard({ source, orgSlug }: { source: SourceListItem; orgSlug?: string }) {
  const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;
  return (
    <Link href={href} className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 hover:border-stone-300 dark:hover:border-stone-600 transition-colors">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">{source.name}</span>
          {source.isPrimary && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded">Primary</span>
          )}
        </div>
        <SourceTypeIcon type={source.type} />
      </div>
      <div className="text-xs text-stone-400 dark:text-stone-500 mt-1.5">
        {source.url && <>{shortUrl(source.url)}</>}
        {source.latestVersion && <>{source.url ? " · " : ""}Latest: {source.latestVersion}</>}
        {source.latestDate && <> · {formatDate(source.latestDate)}</>}
        {source.releaseCount > 0 && <> · {source.releaseCount} releases</>}
      </div>
    </Link>
  );
}
