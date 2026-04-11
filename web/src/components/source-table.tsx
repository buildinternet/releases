import Link from "next/link";
import type { SourceListItem, OrgDetail } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { Sparkline } from "@/components/sparkline";

const typeBadgeClass = "text-[11px] px-1.5 py-0.5 rounded font-medium";

const typeLabels: Record<string, string> = {
  github: "GitHub",
  feed: "Feed",
  scrape: "Webpage",
  agent: "Agent",
};

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    github: "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400",
    feed: "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400",
    scrape: "bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400",
    agent: "bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400",
  };
  return (
    <span className={`${typeBadgeClass} ${colors[type] ?? colors.github}`}>
      {typeLabels[type] ?? type}
    </span>
  );
}

export function SourceTable({
  sources,
  products,
  orgSlug,
  sourceSparklines,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  sourceSparklines?: Record<string, number[]>;
}) {
  const sorted = [...sources].sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return b.releaseCount - a.releaseCount;
  });

  const productMap = new Map(products.map((p) => [p.slug, p.name]));

  return (
    <div className="mt-5">
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-stone-50 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800">
              <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">Source</th>
              <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">Type</th>
              {products.length > 0 && (
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 hidden sm:table-cell">Product</th>
              )}
              <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">Releases</th>
              {sourceSparklines && (
                <th className="px-4 py-2.5 hidden md:table-cell"><span className="sr-only">Activity</span></th>
              )}
              <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 hidden sm:table-cell">Latest</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800/50">
            {sorted.map((source) => (
              <tr key={source.slug} className="hover:bg-stone-50 dark:hover:bg-stone-900/50 transition-colors">
                <td className="px-4 py-3">
                  <Link
                    href={`/${orgSlug}/${source.slug}`}
                    className="text-stone-800 dark:text-stone-200 font-medium hover:text-stone-900 dark:hover:text-stone-100"
                  >
                    {source.name}
                  </Link>
                  {source.url && (
                    <div className="text-[12px] text-stone-400 dark:text-stone-500 truncate max-w-[300px]">
                      {source.url.replace(/^https?:\/\//, "")}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <TypeBadge type={source.type} />
                </td>
                {products.length > 0 && (
                  <td className="px-4 py-3 text-stone-500 dark:text-stone-400 text-[13px] hidden sm:table-cell">
                    {source.productSlug ? productMap.get(source.productSlug) ?? "—" : "—"}
                  </td>
                )}
                <td className="px-4 py-3 text-right font-mono tabular-nums text-stone-700 dark:text-stone-300">
                  {source.releaseCount}
                </td>
                {sourceSparklines && (
                  <td className={`px-4 py-3 hidden md:table-cell ${source.releaseCount > 0 ? "text-stone-500 dark:text-stone-400" : "text-stone-300 dark:text-stone-700"}`}>
                    <Sparkline
                      data={sourceSparklines[source.slug] ?? []}
                      width={80}
                      height={24}
                      id={source.slug}
                    />
                  </td>
                )}
                <td className="px-4 py-3 text-right text-stone-500 dark:text-stone-400 text-[13px] hidden sm:table-cell">
                  {source.latestVersion ? (
                    <span className="text-stone-600 dark:text-stone-300">{source.latestVersion}</span>
                  ) : (
                    formatDate(source.latestDate)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
