"use client";

import { useEffect } from "react";
import { RouteErrorFallback } from "@/components/route-error-fallback";

/**
 * Product / source segment boundary. Keeps site chrome (Header) so a failed
 * product or source data load doesn't white-screen the whole app.
 */
export default function OrgSlugError({
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
        event: "org-slug-error",
        message: error.message,
        digest: error.digest,
        name: error.name,
      }),
    );
  }, [error]);

  return (
    <RouteErrorFallback
      reset={reset}
      title="Couldn't load this page"
      message="This product or source page failed to load. Try again in a moment, or browse from the org page."
    />
  );
}
