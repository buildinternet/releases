import "server-only";

/**
 * Both `NODE_ENV !== "production"` AND a valid `RELEASED_API_KEY` must be
 * present for the Promote source CTA to mount. The dev environment points
 * at the same D1 as prod, so this CTA is intended for developers running
 * the app locally with their admin key. The server action re-checks the
 * same gate so a stray invocation in production cannot mutate the row.
 */
export function isPromoteSourceEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  return Boolean(process.env.RELEASED_API_KEY);
}
