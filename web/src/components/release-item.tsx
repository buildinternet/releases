import type { ReleaseItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ReleaseListItem({ release }: { release: ReleaseItem }) {
  return (
    <div className="border-b border-stone-200 py-4 first:pt-0 last:border-b-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="font-semibold text-[15px] text-stone-900">{release.version ?? "—"}</span>
        <span className="text-xs text-stone-400 whitespace-nowrap ml-4">{formatDate(release.publishedAt)}</span>
      </div>
      <div className="text-sm text-stone-600 mb-1">{release.title}</div>
      <p className="text-[13px] text-stone-500 leading-relaxed">{release.summary}</p>
    </div>
  );
}
