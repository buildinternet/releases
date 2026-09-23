import { type ApiScope } from "@buildinternet/releases-core/api-token";

/**
 * Tool-level insufficient-scope message surfaced to the model. Names BOTH token
 * lanes so a live relu_ user-key holder gets accurate guidance, not just relk_
 * machine-token callers.
 */
export function scopeErrorText(required: ApiScope): string {
  return (
    `insufficient_scope: this MCP tool requires a '${required}'-scoped API key. ` +
    `Present a ${required}-capable key via Authorization: Bearer ` +
    `(relk_… machine token or relu_… user key).`
  );
}
