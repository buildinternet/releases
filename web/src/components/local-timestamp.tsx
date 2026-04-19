"use client";

/**
 * Renders an ISO timestamp in the user's local timezone with a timezone indicator.
 * Falls back to the raw ISO string during SSR hydration to avoid mismatch.
 */

import { useEffect, useState } from "react";

export function LocalTimestamp({
  iso,
  prefix,
  className,
}: {
  iso: string;
  prefix?: string;
  className?: string;
}) {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    setFormatted(
      new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
  }, [iso]);

  // During SSR / before hydration, show date-only in UTC to avoid mismatch
  const fallback = new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <span className={className}>
      {prefix}
      {formatted ?? fallback}
    </span>
  );
}
