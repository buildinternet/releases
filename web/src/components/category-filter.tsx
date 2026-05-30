import Link from "next/link";
import { CATEGORIES, categoryDisplayName } from "@buildinternet/releases-core/categories";
import { catalogHref } from "@/lib/catalog-href";

const CHIP = "rounded-full border px-3 py-1 text-[13px] transition-colors";
const ACTIVE =
  "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900";
const INACTIVE =
  "border-stone-200 text-stone-600 hover:border-stone-300 hover:text-stone-900 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-100";

/**
 * Optional category filter for the catalog — a row of chips over the canonical
 * `CATEGORIES`, plus an "All" reset. Server-rendered links: the active filter
 * lives in the `?category=` query param, and {@link catalogHref} preserves the
 * `?empty=1` toggle across selections. `activeCategory` is null when unfiltered.
 */
export function CategoryFilter({
  activeCategory,
  includeEmpty,
}: {
  activeCategory: string | null;
  includeEmpty: boolean;
}) {
  // `null` is the "All" reset chip; the rest are the canonical categories.
  const chips: Array<string | null> = [null, ...CATEGORIES];
  return (
    <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
      {chips.map((slug) => {
        const isActive = slug === activeCategory;
        return (
          <Link
            key={slug ?? "all"}
            href={catalogHref({ category: slug, includeEmpty })}
            aria-current={isActive ? "true" : undefined}
            className={`${CHIP} ${isActive ? ACTIVE : INACTIVE}`}
          >
            {slug ? categoryDisplayName(slug) : "All"}
          </Link>
        );
      })}
    </div>
  );
}
