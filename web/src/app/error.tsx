"use client";

import { useEffect } from "react";
import { RouteErrorFallback } from "@/components/route-error-fallback";

/**
 * Root segment error boundary. Catches uncaught errors from any route that
 * doesn't define a closer `error.tsx`, so a single page failure can't replace
 * the whole document with Next's bare `__next_error__` shell.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        component: "web-error-boundary",
        event: "route-error",
        message: error.message,
        digest: error.digest,
        name: error.name,
      }),
    );
  }, [error]);

  return <RouteErrorFallback reset={reset} />;
}
