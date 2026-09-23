"use client";

import { RouteErrorFallback } from "@/components/route-error-fallback";

export default function SourceReleasesError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback reset={reset} />;
}
