import Link from "next/link";
import { api } from "@/lib/api";
import type { RelatedScope } from "@/lib/api";

interface RelatedReleasesProps {
  releaseId: string;
  scope?: RelatedScope;
  limit?: number;
  /** Heading shown above the rail. */
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

function releaseHref(item: {
  id: string;
  source: { slug: string };
  orgSlug: string | null;
}): string {
  // Mirror the org/source routing used on the rest of the site. If the
  // release has an org, the canonical path is /{org}/{source}#{id}; the
  // independent-source fallback mirrors /source/{slug}.
  const sourcePath = item.orgSlug
    ? `/${item.orgSlug}/${item.source.slug}`
    : `/source/${item.source.slug}`;
  return `${sourcePath}#${item.id}`;
}

/**
 * Semantically-similar releases rail for a source detail page.
 *
 * Server component — fetches directly from the API on render. Returns
 * `null` when:
 *   - the backend reports `degraded` (missing vectors, Vectorize binding
 *     unavailable, etc.),
 *   - the result list is empty,
 *   - or the fetch throws.
 *
 * Hiding the rail on empty/degraded follows the issue spec: "hide the
 * rail (don't render a placeholder)". This is a progressive enhancement,
 * not a core surface.
 */
export async function RelatedReleases({
  releaseId,
  scope = "global",
  limit = 5,
  title,
}: RelatedReleasesProps) {
  let response;
  try {
    response = await api.relatedReleases(releaseId, { scope, limit });
  } catch {
    return null;
  }
  if (response.degraded || response.items.length === 0) return null;

  const heading = title ?? (scope === "org" ? "More from this team" : "Similar releases");

  return (
    <section className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 mb-3">
        {heading}
      </h2>
      <ul className="flex flex-col gap-2">
        {response.items.map((item) => {
          const date = formatDate(item.publishedAt);
          return (
            <li
              key={item.id}
              className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-3 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
            >
              <Link href={releaseHref(item)} className="block">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-stone-900 dark:text-stone-100 truncate">
                        {item.title}
                      </span>
                      {item.version && (
                        <span className="text-[11px] font-mono text-stone-500 dark:text-stone-400 shrink-0">
                          {item.version}
                        </span>
                      )}
                    </div>
                    {item.summary && (
                      <p className="text-[12.5px] text-stone-500 dark:text-stone-400 mt-1 line-clamp-2">
                        {item.summary}
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500 mt-1.5">
                      <span className="truncate">{item.source.name}</span>
                      {date && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{date}</span>
                        </>
                      )}
                    </div>
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
