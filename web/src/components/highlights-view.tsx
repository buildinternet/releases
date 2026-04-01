import type { ReleaseSummaryItem } from "@/lib/api";

interface HighlightsViewProps {
  rolling: ReleaseSummaryItem | null;
  monthly: ReleaseSummaryItem[];
}

function formatMonthYear(year: number, month: number): string {
  const date = new Date(year, month - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function HighlightsView({ rolling, monthly }: HighlightsViewProps) {
  if (!rolling && monthly.length === 0) {
    return (
      <div className="py-12 text-center text-stone-400 dark:text-stone-500 text-sm">
        No summaries generated yet. Summaries are created automatically when new releases are fetched.
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      {rolling && (
        <div className="bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
              Recent Highlights
            </span>
            <span className="text-[11px] text-stone-300 dark:text-stone-600">
              {rolling.releaseCount} releases · last {rolling.windowDays ?? 90} days
            </span>
          </div>
          <p className="text-[13px] text-stone-700 dark:text-stone-300 leading-relaxed">{rolling.summary}</p>
        </div>
      )}

      {monthly.length > 0 && (
        <div className="space-y-3">
          {monthly
            .sort((a, b) => {
              if (a.year !== b.year) return (b.year ?? 0) - (a.year ?? 0);
              return (b.month ?? 0) - (a.month ?? 0);
            })
            .map((m) => (
              <div key={`${m.year}-${m.month}`} className="bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
                    {m.year && m.month ? formatMonthYear(m.year, m.month) : "Monthly Summary"}
                  </span>
                  <span className="text-[11px] text-stone-300 dark:text-stone-600">
                    {m.releaseCount} releases
                  </span>
                </div>
                <p className="text-[13px] text-stone-700 dark:text-stone-300 leading-relaxed">{m.summary}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
