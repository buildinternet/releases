import Link from "next/link";

export function SourceDatasetPanel({
  pilot,
  basePath,
  sourceUrl,
  releaseCount,
}: {
  pilot: { name: string; description: string };
  basePath: string;
  sourceUrl: string;
  releaseCount?: number;
}) {
  const count =
    typeof releaseCount === "number" && Number.isFinite(releaseCount) && releaseCount >= 0
      ? releaseCount
      : null;
  const [, orgSlug, sourceSlug] = basePath.split("/");
  const apiUrl = `https://api.releases.sh/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(sourceSlug)}`;
  const linkClass =
    "underline decoration-stone-300 underline-offset-2 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 dark:decoration-stone-700 dark:hover:text-stone-100";

  return (
    <section
      aria-labelledby="source-dataset-heading"
      className="mb-6 flex items-start gap-5 rounded-lg border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-900/60 sm:gap-6"
    >
      {count !== null && (
        <div className="shrink-0 pt-0.5">
          <p className="text-[30px] leading-none tracking-tight tabular-nums text-stone-900 dark:text-stone-100">
            {count.toLocaleString("en-US")}
          </p>
          <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-400">
            {count === 1 ? "stable release" : "stable releases"}
          </p>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2
          id="source-dataset-heading"
          className="text-sm font-semibold text-stone-900 dark:text-stone-100"
        >
          {pilot.name}
        </h2>
        <p className="mt-1.5 text-pretty text-sm leading-relaxed text-stone-600 dark:text-stone-400">
          {pilot.description}
        </p>
        <details className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-offset-2 hover:text-stone-900 dark:hover:text-stone-100">
            About the data
          </summary>
          <p className="mt-2 leading-relaxed">
            Indexed by Release Notes Index ·{" "}
            <a href={sourceUrl} className={linkClass}>
              Original source
            </a>
          </p>
          <nav
            aria-label="Release history data access"
            className="mt-2 flex flex-wrap gap-x-4 gap-y-2"
          >
            <a href={`${basePath}.json`} className={linkClass}>
              JSON
            </a>
            <a href={apiUrl} className={linkClass}>
              API
            </a>
            <Link href="/docs/methodology" className={linkClass}>
              Methodology
            </Link>
          </nav>
          <p className="mt-2 text-pretty leading-relaxed">
            Access is paginated. Historical coverage varies; original notes belong to their
            publisher.
          </p>
        </details>
      </div>
    </section>
  );
}
