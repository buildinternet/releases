"use client";

import { RouteErrorFallback } from "@/components/route-error-fallback";

export default function OrgReleasesError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback reset={reset} />;
}
