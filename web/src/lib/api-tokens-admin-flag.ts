import "server-only";

import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

/**
 * Gate for the API tokens admin page — the same dev-only signal as the rest of
 * the local admin surface (non-production + a configured admin Bearer). Server
 * actions re-check it so a stray invocation in production can't mint or revoke.
 */
export function isApiTokensAdminEnabled(): boolean {
  return isLocalAdminEnabled();
}

/**
 * The fixed "primary owner" principal used for all tokens minted through this
 * admin page. The list view filters to only these tokens — not the full system
 * token table.
 */
export const PRIMARY_OWNER = {
  principalType: "user",
  principalId: "usr_web_admin",
} as const;
