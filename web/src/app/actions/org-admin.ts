"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

type ActionResult = { ok: true } | { ok: false; error: string };

function adminEnv(): { apiUrl: string; apiSecret: string } | { error: string } {
  if (!isLocalAdminEnabled()) {
    return { error: "Admin actions are disabled in this environment." };
  }
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";
  const apiSecret = process.env.RELEASED_API_KEY;
  if (!apiSecret) return { error: "RELEASED_API_KEY not configured." };
  return { apiUrl, apiSecret };
}

export async function setOrgHiddenAction(input: {
  slug: string;
  hidden: boolean;
}): Promise<ActionResult> {
  const env = adminEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/orgs/${encodeURIComponent(input.slug)}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ isHidden: input.hidden }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // Bust the homepage (ticker + directory table) and the org detail page.
  revalidatePath("/");
  revalidatePath(`/${input.slug}`);
  return { ok: true };
}
