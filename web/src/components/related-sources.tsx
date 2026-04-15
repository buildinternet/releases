import Link from "next/link";
import { api } from "@/lib/api";
import type { RelatedScope } from "@/lib/api";

interface RelatedSourcesProps {
  /** Slug or id of the anchor source. */
  source: string;
  scope?: RelatedScope;
  limit?: number;
  title?: string;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return null;
  }
}

function sourceHref(item: {
  slug: string;
  orgSlug: string | null;
}): string {
  return item.orgSlug ? `/${item.orgSlug}/${item.slug}` : `/source/${item.slug}`;
}

/**
 * Semantically-similar sources rail for a source detail page.
 *
 * Hides itself on degraded responses, empty results, or fetch errors —
 * see `RelatedReleases` for rationale.
 */
export async function RelatedSources({
  source,
  scope = "global",
  limit = 5,
  title,
}: RelatedSourcesProps) {
  let response;
  try {
    response = await api.relatedSources(source, { scope, limit });
  } catch {
    return null;
  }
  if (response.degraded || response.items.length === 0) return null;

  const heading = title ?? (scope === "org" ? "Sibling sources" : "Similar sources");

  return (
    <section className="mt-6">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {response.items.map((item) => {
          const latest = formatDate(item.latestDate);
          return (
            <li key={item.id}>
              <Link
                href={sourceHref(item)}
                className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-stone-900 dark:text-stone-100 truncate">
                      {item.name}
                    </div>
                    {item.orgName && (
                      <div className="text-[11px] text-stone-400 dark:text-stone-500 truncate">
                        {item.orgName}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {item.releaseCount > 0 && (
                      <div className="text-[12px] font-mono text-stone-500 dark:text-stone-400">
                        {item.releaseCount} {item.releaseCount === 1 ? "release" : "releases"}
                      </div>
                    )}
                    {latest && (
                      <div className="text-[10.5px] text-stone-400 dark:text-stone-500">
                        {latest}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
