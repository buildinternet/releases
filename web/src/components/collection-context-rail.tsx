import Link from "next/link";
import { ReportIssue } from "@/components/report-issue";
import type { ReportContext } from "@/lib/report-issue";
import type { CollectionWeeklyDigestListItem } from "@/lib/api";
import { weekOfLabel } from "@/lib/digest-format";

/**
 * Right-hand context rail for a collection page — latest weekly digests,
 * export formats, and report. Mirrors the org feed shell (`.org-surface`
 * tokens; parent stacks under the feed on narrow viewports).
 */
export function CollectionContextRail({
  formatPath,
  report,
  digests = [],
}: {
  /** Path export links hang off, e.g. `/collections/frontier-ai-labs`. */
  formatPath: string;
  report: ReportContext;
  /** Newest-first recent digests (typically 2–3). Empty → section omitted. */
  digests?: CollectionWeeklyDigestListItem[];
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 md:w-[268px] lg:sticky lg:top-20">
      {digests.length > 0 && (
        <div className="rounded-[13px] border border-[var(--line)] bg-[var(--surface)] px-[17px] py-4">
          <RailEyebrow>Weekly digests</RailEyebrow>
          <ul className="mt-3 flex flex-col gap-3.5">
            {digests.map((d) => (
              <li key={d.id}>
                <Link href={`${formatPath}/digest/${d.weekStart}`} className="group/digest block">
                  <div className="text-[11px] font-medium text-[var(--fg-3)]">
                    {weekOfLabel(d.weekStart)}
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold leading-snug text-[var(--fg)] transition-colors group-hover/digest:text-[var(--accent)]">
                    {d.title}
                  </div>
                  {d.intro && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--fg-3)]">
                      {d.intro}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href={`${formatPath}/digest`}
            className="mt-3.5 inline-block text-[12px] text-[var(--fg-2)] underline decoration-[var(--line-2)] underline-offset-2 transition-colors hover:text-[var(--fg)] hover:decoration-[var(--fg-3)]"
          >
            Browse all digests →
          </Link>
        </div>
      )}

      <div>
        <RailEyebrow className="ml-0.5">Export</RailEyebrow>
        <div className="mt-2.5 flex gap-2">
          {(["json", "md", "atom"] as const).map((ext) => (
            <a
              key={ext}
              href={`${formatPath}.${ext}`}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] py-[7px] font-mono text-[11.5px] text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
            >
              .{ext}
            </a>
          ))}
        </div>
      </div>

      <div className="mt-1 ml-0.5">
        <ReportIssue
          context={report}
          className="text-[12.5px] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)] underline-offset-2 hover:underline"
        />
      </div>
    </aside>
  );
}

function RailEyebrow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-3)] ${className}`}
    >
      {children}
    </div>
  );
}
