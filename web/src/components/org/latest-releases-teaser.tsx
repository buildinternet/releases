import Link from "next/link";
import type { OrgReleaseItem } from "@/lib/api";
import { formatDate } from "@/lib/formatters";
import { orgEyebrowClass } from "./ui";
import { ArrowRightIcon, ChevronRightIcon } from "./icons";

/**
 * Overview "Latest releases" teaser — a short card of the newest releases that
 * links through to the full Releases tab. A read-only summary; the Releases tab
 * owns filtering, search, and per-release actions.
 */
export function LatestReleasesTeaser({
  orgSlug,
  releases,
  count = 3,
}: {
  orgSlug: string;
  releases: OrgReleaseItem[];
  count?: number;
}) {
  const items = releases.slice(0, count);
  if (items.length === 0) return null;
  const releasesHref = `/${orgSlug}/releases`;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className={orgEyebrowClass}>Latest releases</h2>
        <Link
          href={releasesHref}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--accent)]"
        >
          See all releases
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)]">
        {items.map((r, i) => {
          const label = r.titleShort || r.title;
          const meta = [r.product?.name, r.version].filter(Boolean).join(" · ");
          return (
            <Link
              key={r.id ?? `${label}-${i}`}
              href={releasesHref}
              className="flex items-center gap-3.5 border-t border-[var(--line)] px-4 py-3.5 transition-colors first:border-t-0 hover:bg-[var(--surface-2)]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-[var(--fg)]">{label}</div>
                {meta && (
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--fg-3)]">
                    {meta}
                  </div>
                )}
              </div>
              {r.publishedAt && (
                <span className="shrink-0 font-mono text-[11.5px] text-[var(--fg-3)]">
                  {formatDate(r.publishedAt)}
                </span>
              )}
              <ChevronRightIcon className="h-[15px] w-[15px] shrink-0 text-[var(--fg-3)]" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
