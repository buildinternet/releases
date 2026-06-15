"use server";

import { revalidatePath } from "next/cache";
import type { Notice } from "@buildinternet/releases-core/notice";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Set or clear the curator notice on a product via
 * `PATCH /v1/orgs/:orgSlug/products/:productSlug`. Pass a `Notice` to set it or
 * `null` to clear it; the server merges it into the product's metadata and
 * validates the shape with `NoticeSchema`.
 */
export async function setProductNoticeAction(input: {
  orgSlug: string;
  productSlug: string;
  notice: Notice | null;
}): Promise<ActionResult> {
  const env = await adminActionEnv();
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
      body: JSON.stringify({ notice: input.notice }),
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
  return { ok: true };
}

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
  const env = await adminActionEnv();
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
