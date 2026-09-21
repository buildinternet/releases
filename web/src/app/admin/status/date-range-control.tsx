"use client";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

/**
 * Status date ranges. `short` is the compact chip on the closed control
 * (OpenRouter-style density); the query window is still Today / This Week /
 * This Month / All Time.
 */
export const STATUS_DATE_RANGES = [
  { value: "today", label: "Today", short: "1d" },
  { value: "week", label: "This Week", short: "1w" },
  { value: "month", label: "This Month", short: "1mo" },
  { value: "all", label: "All Time", short: "all" },
] as const;

export type StatusDateRange = (typeof STATUS_DATE_RANGES)[number]["value"];

function isStatusDateRange(value: unknown): value is StatusDateRange {
  return STATUS_DATE_RANGES.some((range) => range.value === value);
}

function RangeChip({ short }: { short: string }) {
  return (
    <span className="rounded bg-muted px-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
      {short}
    </span>
  );
}

/** Compact date-range menu shared by every Status tab. */
export function DateRangeControl({
  value,
  onChange,
}: {
  value: StatusDateRange;
  onChange: (range: StatusDateRange) => void;
}) {
  const current =
    STATUS_DATE_RANGES.find((range) => range.value === value) ?? STATUS_DATE_RANGES[1];

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (isStatusDateRange(next)) onChange(next);
      }}
      items={STATUS_DATE_RANGES.map((range) => ({ value: range.value, label: range.label }))}
    >
      <SelectTrigger size="sm" aria-label="Date range" className="mb-1.5 shrink-0">
        <RangeChip short={current.short} />
        {current.label}
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        {STATUS_DATE_RANGES.map((range) => (
          <SelectItem key={range.value} value={range.value}>
            <RangeChip short={range.short} />
            {range.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
