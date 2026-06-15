"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Toggle a collection's homepage-featured flag. The credential comes from
 * `adminActionEnv()` (root key in local dev; the caller's role-clamped per-user
 * JWT in production), so the API enforces `admin` scope — a non-admin caller is
 * refused with a 403.
 */
export async function setCollectionFeaturedAction(input: {
  slug: string;
  featured: boolean;
}): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/collections/${encodeURIComponent(input.slug)}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ isFeatured: input.featured }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // Bust the homepage promo block, the collections index, and this detail page.
  revalidatePath("/");
  revalidatePath("/collections");
  revalidatePath(`/collections/${input.slug}`);
  return { ok: true };
}
