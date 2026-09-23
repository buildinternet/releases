import { diffVersions } from "@/lib/cadence";

interface VersionRangeDiffProps {
  from: string;
  to: string;
  collapsed?: boolean;
}

export function VersionRangeDiff({ from, to, collapsed = false }: VersionRangeDiffProps) {
  if (collapsed || from === to) {
    return <span className="tabular-nums">{to}</span>;
  }

  const { commonPrefix, fromSuffix, toSuffix } = diffVersions(from, to);

  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums">
      <span>
        {commonPrefix}
        {fromSuffix && (
          <span className="px-0.5 rounded-sm bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300">
            {fromSuffix}
          </span>
        )}
      </span>
      <span aria-hidden="true" className="text-stone-400 dark:text-stone-500">
        →
      </span>
      <span className="sr-only"> to </span>
      <span>
        {commonPrefix}
        {toSuffix && (
          <span className="px-0.5 rounded-sm bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">
            {toSuffix}
          </span>
        )}
      </span>
    </span>
  );
}
