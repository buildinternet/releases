import Link from "next/link";
import type { CollectionWeeklyDigestDetail, CollectionWeeklyDigestListItem } from "@/lib/api";
import { OrgAvatar } from "@/components/org-avatar";
import { sectionProducts } from "@/lib/digest-reel";
import { pluralReleases } from "@/lib/formatters";
import { weekRangeLabel, shortMonthDayLabel } from "@/lib/digest-format";

/**
 * Collection page hero: leads with the latest weekly digest issue instead of
 * the one-line "This week: …" teaser. Left column is the issue itself (title,
 * intro, CTA); right column ("In this issue") deep-links each section to its
 * anchor on the digest page. An "Earlier" strip below surfaces the last
 * couple of back issues. `.org-surface` tokens throughout — matches
 * `Collection-Hero.dc.html`'s top half (dark mockup; tokens carry light mode).
 */
export function LatestDigestHero({
  slug,
  digest,
  earlier,
}: {
  slug: string;
  digest: CollectionWeeklyDigestDetail;
  earlier: CollectionWeeklyDigestListItem[];
}) {
  const digestPath = `/collections/${slug}/digest/${digest.weekStart}`;
  const sections = digest.sections ?? [];
  const earlierShown = earlier.slice(0, 2);

  return (
    <>
      <article
        aria-labelledby="latest-digest-title"
        className="mt-7 flex flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)] md:flex-row"
      >
        <div className="flex flex-1 flex-col gap-3.5 px-6 py-6 md:px-8">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--accent)]">
              This week&apos;s digest
            </span>
            <span className="font-mono text-[11px] text-[var(--fg-3)]">
              {weekRangeLabel(digest.weekStart)}
            </span>
          </div>
          <h2
            id="latest-digest-title"
            className="max-w-[38ch] text-balance text-[26px] font-semibold leading-tight tracking-tight text-[var(--fg)]"
          >
            {digest.title}
          </h2>
          {digest.intro && (
            <p className="max-w-[62ch] text-pretty text-[15px] leading-relaxed text-[var(--fg-2)]">
              {digest.intro}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-4">
            <Link
              href={digestPath}
              className="inline-flex h-10 items-center rounded-lg bg-[var(--fg)] px-4 text-[13.5px] font-semibold text-[var(--page)] transition-opacity hover:opacity-90"
            >
              Read the digest
            </Link>
            <span className="font-mono text-[11px] text-[var(--fg-3)]">
              {digest.releaseCount} {pluralReleases(digest.releaseCount)} covered
            </span>
          </div>
        </div>

        {sections.length > 0 && (
          <div className="flex flex-none flex-col gap-1.5 border-t border-[var(--line)] bg-[var(--surface-2)] px-5 py-5 md:w-[400px] md:border-l md:border-t-0">
            <div className="ml-2 mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-3)]">
              In this issue
            </div>
            {sections.map((section, i) => {
              // Server-hydrated, so ids that no longer resolve (e.g. a
              // release suppressed since generation) are already dropped —
              // unlike `releaseIds.length`.
              const releases = section.releases ?? [];
              const products = sectionProducts({ releases });
              const resolvedCount = releases.length;
              return (
                <Link
                  key={section.anchor}
                  href={`${digestPath}#${section.anchor}`}
                  className="flex gap-3 rounded-lg p-2 text-[var(--fg)] transition-colors hover:bg-[var(--surface)]"
                >
                  <span className="pt-0.5 font-mono text-[11px] text-[var(--fg-3)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex flex-1 flex-col gap-1">
                    <span className="text-[14px] leading-snug">{section.heading}</span>
                    <span className="flex flex-wrap items-center gap-2.5 text-[12px] text-[var(--fg-2)]">
                      {products.map((p) => (
                        <span key={p.key} className="inline-flex items-center gap-1.5">
                          <OrgAvatar
                            avatarUrl={p.org.avatarUrl ?? null}
                            githubHandle={p.org.githubHandle ?? null}
                            name={p.name}
                            size={14}
                          />
                          {p.name}
                        </span>
                      ))}
                      <span className="font-mono text-[10.5px] text-[var(--fg-3)]">
                        {resolvedCount} {pluralReleases(resolvedCount)}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </article>

      {earlierShown.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-7 gap-y-2 px-1 text-[13px]">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-3)]">
            Earlier
          </span>
          {earlierShown.map((d) => (
            <Link
              key={d.id}
              href={`/collections/${slug}/digest/${d.weekStart}`}
              className="flex items-center gap-2 text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
            >
              <span className="pt-px font-mono text-[11px] text-[var(--fg-3)]">
                {shortMonthDayLabel(d.weekStart)}
              </span>
              {d.title}
            </Link>
          ))}
          <Link
            href={`/collections/${slug}/digest`}
            className="text-[12px] text-[var(--fg-2)] underline decoration-[var(--line-2)] underline-offset-2 transition-colors hover:text-[var(--fg)] hover:decoration-[var(--fg-3)] md:ml-auto"
          >
            All digests →
          </Link>
        </div>
      )}
    </>
  );
}
