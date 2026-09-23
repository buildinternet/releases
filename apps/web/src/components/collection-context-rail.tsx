import { ReportIssue } from "@/components/report-issue";
import type { ReportContext } from "@/lib/report-issue";

/**
 * Right-hand context rail for a collection page — export formats and report.
 * The weekly-digest list moved up into the {@link LatestDigestHero} "Earlier"
 * strip. Mirrors the org feed shell (`.org-surface` tokens; parent stacks
 * under the feed on narrow viewports).
 */
export function CollectionContextRail({
  formatPath,
  report,
}: {
  /** Path export links hang off, e.g. `/collections/frontier-ai-labs`. */
  formatPath: string;
  report: ReportContext;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 md:w-[268px] lg:sticky lg:top-20">
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
