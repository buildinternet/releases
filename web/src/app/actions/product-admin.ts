"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Rename a product's display name via
 * `PATCH /v1/orgs/:orgSlug/products/:productSlug`. Sends only `name`; the slug
 * and URL are untouched.
 */
export async function renameProductAction(input: {
  orgSlug: string;
  productSlug: string;
  name: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/products/${encodeURIComponent(input.productSlug)}`;
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

  revalidatePath(`/${input.orgSlug}/${input.productSlug}`);
  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}
