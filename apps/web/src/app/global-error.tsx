"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for failures in the root layout itself. Must render
 * its own `<html>` / `<body>` — the root layout is not mounted when this runs.
 * Keep chrome minimal; segment `error.tsx` + `RouteErrorFallback` handle the
 * normal case with full site Header navigation.
 */
export default function GlobalError({
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
        event: "global-error",
        message: error.message,
        digest: error.digest,
        name: error.name,
      }),
    );
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: "#fafaf9",
          color: "#1c1917",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: 28 * 16, textAlign: "center" }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "#a8a29e",
            }}
          >
            Error
          </p>
          <h1
            style={{
              margin: "0.5rem 0 0",
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            Something went wrong
          </h1>
          <p style={{ margin: "0.75rem 0 0", fontSize: 14, lineHeight: 1.5, color: "#78716c" }}>
            The app hit an unexpected error. Try again, or go back home.
          </p>
          <div
            style={{
              marginTop: "1.75rem",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 36,
                padding: "0 1rem",
                borderRadius: 9999,
                border: "none",
                background: "#1c1917",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                minHeight: 36,
                padding: "0 1rem",
                borderRadius: 9999,
                display: "inline-flex",
                alignItems: "center",
                fontSize: 14,
                fontWeight: 500,
                color: "#57534e",
                textDecoration: "none",
              }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
