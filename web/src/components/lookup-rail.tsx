import Link from "next/link";
import type { LookupResultPayload } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { SourceTypeIcon } from "./source-type-icon";

/**
 * Renders the on-demand lookup rail attached to coordinate-shaped search
 * queries (e.g. `koute/bytehound`) when no curated entity matches. Five
 * outcomes, all surfaced through one component so the page never loses
 * the slot when the status changes between renders:
 *
 *  - `indexed`  — fresh materialization, releases attached.
 *  - `existing` — already indexed, returned via lookup rail rather than catalog.
 *  - `empty`    — repo exists but publishes no releases.
 *  - `not_found`— 404 / private / archived.
 *  - `deferred` — async indexing path (placeholder; not wired in v1).
 *
 * The "did you mean" rail rides along on every status: when the org segment
 * unambiguously matches a curated org, we show that org's top sources so
 * the user has a recovery path even if their exact coordinate missed.
 */
export function LookupRail({ query, payload }: { query: string; payload: LookupResultPayload }) {
  return (
    <section className="mt-6 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-900/40 p-4">
      <LookupHeading query={query} payload={payload} />

      {payload.releases && payload.releases.length > 0 && payload.source && (
        <ReleasesPreview
          source={payload.source}
          releases={payload.releases}
          heading={payload.status === "existing" ? "Recent releases" : "Newly indexed releases"}
        />
      )}

      {payload.relatedOrg && <RelatedOrgRail relatedOrg={payload.relatedOrg} query={query} />}
    </section>
  );
}

function LookupHeading({ query, payload }: { query: string; payload: LookupResultPayload }) {
  const ghUrl = `https://github.com/${query}`;

  if (payload.status === "indexed" || payload.status === "existing") {
    const verb = payload.status === "indexed" ? "Just indexed" : "Indexed";
    return (
      <>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            {verb}
          </span>
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
            {payload.source?.name ?? query}
          </span>
          <SourceTypeIcon type="github" size={12} />
        </div>
        {payload.source && (
          <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1">
            We pulled this from GitHub on demand.{" "}
            <Link
              href={`/source/${payload.source.slug}`}
              className="text-stone-700 dark:text-stone-200 hover:underline"
            >
              View source →
            </Link>
          </p>
        )}
      </>
    );
  }

  if (payload.status === "empty") {
    return (
      <>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            No releases yet
          </span>
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
            {query}
          </span>
        </div>
        <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1">
          We checked{" "}
          <a
            href={ghUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-700 dark:text-stone-200 hover:underline"
          >
            github.com/{query}
          </a>{" "}
          — it&rsquo;s a real repo but doesn&rsquo;t publish tagged releases or a CHANGELOG yet.
          We&rsquo;ll start tracking it the moment it does.
        </p>
      </>
    );
  }

  if (payload.status === "not_found") {
    return (
      <>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            Not found
          </span>
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
            {query}
          </span>
        </div>
        <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1">
          We couldn&rsquo;t find a public repo at{" "}
          <a
            href={ghUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-700 dark:text-stone-200 hover:underline"
          >
            github.com/{query}
          </a>
          . It may be private, archived, or renamed.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          Indexing
        </span>
        <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
          {query}
        </span>
      </div>
      <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-1">
        We&rsquo;re pulling this from GitHub now. Try the same search again in a moment.
      </p>
    </>
  );
}

function ReleasesPreview({
  source,
  releases,
  heading,
}: {
  source: NonNullable<LookupResultPayload["source"]>;
  releases: NonNullable<LookupResultPayload["releases"]>;
  heading: string;
}) {
  const preview = releases.slice(0, 5);
  const remainder = releases.length - preview.length;

  return (
    <div className="mt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
        {heading}
      </h3>
      <ul className="divide-y divide-stone-200 dark:divide-stone-800 border-y border-stone-200 dark:border-stone-800">
        {preview.map((rel) => (
          <li key={rel.id}>
            <Link
              href={`/release/${rel.id}`}
              className="flex items-baseline justify-between gap-3 py-1.5 hover:bg-white/60 dark:hover:bg-stone-900/60 -mx-2 px-2 rounded"
            >
              <div className="min-w-0 flex items-baseline gap-2">
                <span className="font-medium text-[13px] text-stone-900 dark:text-stone-100 truncate">
                  {rel.version ?? rel.title}
                </span>
                {rel.version && rel.title && rel.version !== rel.title && (
                  <span className="text-[12px] text-stone-500 dark:text-stone-400 truncate">
                    {rel.title}
                  </span>
                )}
              </div>
              {rel.publishedAt && (
                <time className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
                  {formatDate(rel.publishedAt)}
                </time>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {remainder > 0 && (
        <p className="text-[12px] text-stone-500 dark:text-stone-400 mt-2">
          <Link href={`/source/${source.slug}`} className="hover:underline">
            View {remainder} more {remainder === 1 ? "release" : "releases"} →
          </Link>
        </p>
      )}
    </div>
  );
}

function RelatedOrgRail({
  relatedOrg,
  query,
}: {
  relatedOrg: NonNullable<LookupResultPayload["relatedOrg"]>;
  query: string;
}) {
  const orgSegment = query.split("/")[0] ?? "";
  return (
    <div className="mt-4 pt-4 border-t border-stone-200 dark:border-stone-800">
      <p className="text-[12px] text-stone-500 dark:text-stone-400 mb-2">
        We don&rsquo;t have <code className="text-[12px]">{query}</code>, but here&rsquo;s what we
        track from{" "}
        <Link
          href={`/${relatedOrg.org.slug}`}
          className="font-medium text-stone-700 dark:text-stone-200 hover:underline"
        >
          {relatedOrg.org.name}
        </Link>
        {orgSegment && orgSegment !== relatedOrg.org.name && (
          <>
            {" "}
            (<code className="text-[12px]">{orgSegment}</code> on GitHub)
          </>
        )}
        :
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {relatedOrg.sources.map((src) => (
          <li key={src.id}>
            <Link
              href={`/${relatedOrg.org.slug}/${src.slug}`}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
            >
              <SourceTypeIcon type="github" size={14} />
              <span className="text-[13px] font-medium text-stone-900 dark:text-stone-100 truncate">
                {src.name}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
