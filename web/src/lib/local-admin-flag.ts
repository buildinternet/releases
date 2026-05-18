import "server-only";

/**
 * Gates the local-development-only admin UI mounted on release detail pages.
 * Same shape as `isPromoteSourceEnabled` — both production signals must be
 * absent and the admin Bearer token must be configured. Server actions that
 * call mutating endpoints re-check this so a stray invocation in production
 * cannot mutate state.
 */
export function isLocalAdminEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  return Boolean(process.env.RELEASED_API_KEY);
}
