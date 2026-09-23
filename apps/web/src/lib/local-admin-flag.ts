import "server-only";
import { serverApiKey } from "./env";

/**
 * Gates the local-development-only admin UI (org, source, and release admin
 * menus). Both production signals must be absent and the admin Bearer token
 * must be configured. Server actions that call mutating endpoints re-check this
 * so a stray invocation in production cannot mutate state.
 */
export function isLocalAdminEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  return Boolean(serverApiKey());
}
