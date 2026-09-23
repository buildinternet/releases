/**
 * Re-exports from @releases/core-internal/api-token-store — the shared
 * verification path for both the API and MCP workers. Keeps existing importers
 * (auth.ts, tests) on the same specifier.
 */
export {
  verifyApiToken,
  touchLastUsed,
  type TokenVerifyResult,
} from "@releases/core-internal/api-token-store";
