import "server-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

/**
 * Gate for the site-notice admin page — the same dev-only signal as the rest of
 * the local admin surface (non-production + a configured admin Bearer). Server
 * actions re-check it so a stray invocation in production cannot publish.
 */
export function isSiteNoticeAdminEnabled(): boolean {
  return isLocalAdminEnabled();
}
