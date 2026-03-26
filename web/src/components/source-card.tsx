import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";
import type { SourceListItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function hostname(url?: string) {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

export function SourceCard({ source, orgSlug }: { source: SourceListItem; orgSlug?: string }) {
  const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;
  return (
    <Link href={href} className="block bg-white border border-stone-200 rounded-lg p-4 hover:border-stone-300 transition-colors">
      <div className="flex justify-between items-center">
        <span className="font-semibold text-[15px] text-stone-900">{source.name}</span>
        <SourceTypeIcon type={source.type} />
      </div>
      {source.url && <div className="text-[13px] text-stone-500 mt-1">{hostname(source.url)}</div>}
      <div className="text-xs text-stone-400 mt-2">
        {source.latestVersion && <>Latest: {source.latestVersion}</>}
        {source.latestDate && <> · {formatDate(source.latestDate)}</>}
        {source.releaseCount > 0 && <> · {source.releaseCount} releases</>}
      </div>
    </Link>
  );
}
