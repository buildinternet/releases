"use server";

import { revalidatePath } from "next/cache";
import type { SiteNotice, StoredSiteNotice } from "@buildinternet/releases-core/site-notice";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Read the stored notice (including a draft `active: false`) using the admin
 * Bearer, so the form can edit an unpublished notice. Returns null when unset
 * or the gate is closed.
 */
export async function getSiteNoticeAdminAction(): Promise<StoredSiteNotice | null> {
  const env = await adminActionEnv();
  if ("error" in env) return null;
  try {
    const res = await fetch(`${env.apiUrl}/v1/site-notice`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.apiSecret}` }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { notice: StoredSiteNotice | null };
    return body.notice;
  } catch {
    return null;
  }
}

/** Publish/update the site notice via PUT /v1/site-notice (admin Bearer). */
export async function setSiteNoticeAction(notice: SiteNotice): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/site-notice`, {
      method: "PUT",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(notice),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // The banner renders in the root layout (every route) and the card on the home
  // page — bust both. (Prod web cache picks up via the ~60s ISR window.)
  revalidatePath("/", "layout");
  return { ok: true };
}
