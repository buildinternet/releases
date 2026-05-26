"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Shallow-merge a patch into the source's `metadata` blob via
 * `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug/metadata`. A `null` value for a
 * key deletes that key server-side; all other keys are merged.
 */
export async function setSourceMetadataAction(input: {
  orgSlug: string;
  sourceSlug: string;
  patch: Record<string, unknown>;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}/metadata`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(input.patch),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}/${input.sourceSlug}`);
  return { ok: true };
}

/**
 * Un-hide an on-demand source so it appears in listings, sitemap, and AI
 * features. Sets `isHidden: false` via the org-scoped source PATCH.
 */
export async function promoteSourceAction(input: {
  orgSlug: string;
  sourceSlug: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ isHidden: false }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}/${input.sourceSlug}`);
  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}

/**
 * Rename a source's display name via
 * `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug`. Sends only `name`; the slug and
 * URL are untouched. (The API re-embeds the source when its name changes.)
 */
export async function renameSourceAction(input: {
  orgSlug: string;
  sourceSlug: string;
  name: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ name: input.name }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}/${input.sourceSlug}`);
  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}
