/**
 * The implementation moved to @releases/core-internal/api-token-store so the
 * MCP worker shares one verification path (scoped API tokens — Phase 2). This
 * re-export keeps existing importers (auth.ts, tests) on the same specifier.
 */
export {
  verifyApiToken,
  touchLastUsed,
  type TokenVerifyResult,
} from "@releases/core-internal/api-token-store";
