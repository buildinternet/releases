"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { isPromoteSourceEnabled } from "@/lib/promote-source-flag";

export async function promoteSourceAction(input: {
  orgSlug: string;
  sourceSlug: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPromoteSourceEnabled()) {
    return { ok: false, error: "Promote is disabled in this environment." };
  }
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";
  const apiSecret = process.env.RELEASED_API_KEY;
  if (!apiSecret) return { ok: false, error: "RELEASED_API_KEY not configured." };

  let res: Response;
  try {
    const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}`;
    res = await fetch(`${apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiSecret}`,
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
