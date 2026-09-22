"use server";

import type { MarketingClassifierState } from "@buildinternet/releases-api-types";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true; data: MarketingClassifierState } | { ok: false; error: string };

export async function getMarketingClassifierStateAction(): Promise<MarketingClassifierState | null> {
  const env = await adminActionEnv();
  if ("error" in env) return null;
  try {
    const res = await fetch(`${env.apiUrl}/v1/admin/marketing-classifier`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.bearer}` }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MarketingClassifierState;
  } catch {
    return null;
  }
}

export async function setMarketingClassifierThresholdAction(
  threshold: number,
): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/admin/marketing-classifier`, {
      method: "PUT",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.bearer}`,
      }),
      body: JSON.stringify({ threshold }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }
  return { ok: true, data: (await res.json()) as MarketingClassifierState };
}

type SourcePatchResult = { ok: true } | { ok: false; error: string };

/**
 * Toggle / edit a source's `marketingFilter` + `marketingFilterHint` via the
 * existing `PATCH /v1/sources/:id/metadata` JSON-merge route — no duplicate
 * write path. `hint: null` deletes the stored hint.
 */
export async function setSourceMarketingFilterAction(
  sourceId: string,
  patch: { marketingFilter?: boolean; marketingFilterHint?: string | null },
): Promise<SourcePatchResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/sources/${encodeURIComponent(sourceId)}/metadata`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.bearer}`,
      }),
      body: JSON.stringify(patch),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }
  return { ok: true };
}
