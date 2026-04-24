/**
 * Builds the `resources[]` payload for `client.beta.sessions.create()` that
 * attaches our managed-agents memory stores. Shared between the worker DO
 * session path and the legacy dev-CLI discovery path. See #537.
 *
 * Trust model is path-based, not access-mode-based: both mounts are read_write,
 * and the attach instructions steer agents toward `observations.md` (errata
 * store) and the tool-notes paths for in-session writes. `errata.md` entries
 * land via the admin write endpoint or a future promotion routine, not
 * directly from content-session writes.
 */

export interface MemoryStoreAttachContext {
  mode: "onboard" | "update";
  /** Required for `mode=update`; absent for discovery/onboard. */
  orgId?: string;
  errataStoreId?: string;
  toolNotesStoreId?: string;
}

export interface MemoryStoreResource {
  type: "memory_store";
  memory_store_id: string;
  access: "read_write";
  instructions: string;
}

function errataInstructions(ctx: MemoryStoreAttachContext): string {
  if (ctx.mode === "update" && ctx.orgId) {
    return [
      `This store carries per-organization errata and observations. You are working on org ${ctx.orgId}.`,
      `Before fetching sources, read /orgs/${ctx.orgId}/errata.md — those are trusted rules (URL patterns to skip, date formats, parse quirks) written by prior reviews.`,
      `Also read /orgs/${ctx.orgId}/observations.md — these are unvalidated priors from recent sessions. Treat them as hints, not rules.`,
      `If you notice something fresh worth logging (a quirky pattern, a false-positive URL, a format variant), append to /orgs/${ctx.orgId}/observations.md. Do NOT write to errata.md directly — trusted rules land there via promotion.`,
      `Keep entries short and factual. Promotion happens out-of-band.`,
    ].join("\n\n");
  }
  return [
    "This store carries per-organization errata and cross-org discovery notes. You are in discovery/onboard mode and no org is resolved yet.",
    "If you notice something worth remembering about the discovery process itself (heuristics that work across orgs, common traps, provider-level patterns), append to /discovery/global.md.",
    "Do NOT write to /orgs/<org_id>/... paths — those belong to org-scoped sessions that have an orgId in hand.",
    "Keep entries short and factual.",
  ].join("\n\n");
}

function toolNotesInstructions(): string {
  return [
    "This store carries global harness and MCP tool quirks. Log tool errors and workarounds you want to remember across sessions.",
    "Paths: /tools/<tool_name>.md for custom tools, /mcp/<server>/<tool>.md for MCP tools, /harness/notes.md for cross-cutting observations.",
    "Write sparingly — only when you hit a genuine tool error or a non-obvious workaround. This is not session chatter or per-org notes (those belong in the errata store).",
    "Keep entries short and factual. Promotion target is code changes, not another memory.",
  ].join("\n\n");
}

/**
 * Returns the `resources[]` array. Empty when both store IDs are unset —
 * safe default for dev setups without memory configured.
 */
export function buildMemoryStoreResources(ctx: MemoryStoreAttachContext): MemoryStoreResource[] {
  const resources: MemoryStoreResource[] = [];
  if (ctx.errataStoreId) {
    resources.push({
      type: "memory_store",
      memory_store_id: ctx.errataStoreId,
      access: "read_write",
      instructions: errataInstructions(ctx),
    });
  }
  if (ctx.toolNotesStoreId) {
    resources.push({
      type: "memory_store",
      memory_store_id: ctx.toolNotesStoreId,
      access: "read_write",
      instructions: toolNotesInstructions(),
    });
  }
  return resources;
}
