import type { MeWorkspace, MeWorkspacesResponse } from "@buildinternet/releases-api-types";
import { apiFetch } from "./core.js";

export type { MeWorkspace } from "@buildinternet/releases-api-types";

/** List the signed-in user's workspaces (Better Auth organizations). */
export async function listMyWorkspaces(): Promise<MeWorkspace[]> {
  const res = await apiFetch<MeWorkspacesResponse | null>(`/v1/me/workspaces`);
  return res?.workspaces ?? [];
}

/**
 * Resolve a `--workspace <id-or-slug>` value against the caller's own
 * workspaces. There is no server-side lookup-by-slug route, so this always
 * fetches the caller's workspace list and matches locally: an exact `id`
 * match first, then an exact `slug` match. Returns the full list alongside
 * the match (or `null`) so a caller can print "here are your workspaces" on a
 * miss without a second round-trip.
 */
export async function resolveWorkspace(
  identifier: string,
): Promise<{ match: MeWorkspace | null; all: MeWorkspace[] }> {
  const all = await listMyWorkspaces();
  const match =
    all.find((w) => w.id === identifier) ?? all.find((w) => w.slug === identifier) ?? null;
  return { match, all };
}
