"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true; redirectTo?: string } | { ok: false; error: string };

export async function suppressReleaseAction(input: {
  id: string;
  reason?: string;
  redirectTo?: string;
}): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/releases/${encodeURIComponent(input.id)}/suppress`, {
      method: "POST",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/release/${input.id}`);
  if (input.redirectTo) revalidatePath(input.redirectTo);
  return { ok: true, redirectTo: input.redirectTo };
}

export async function deleteReleaseAction(input: {
  id: string;
  redirectTo?: string;
}): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/releases/${encodeURIComponent(input.id)}`, {
      method: "DELETE",
      headers: webApiHeaders({
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/release/${input.id}`);
  if (input.redirectTo) revalidatePath(input.redirectTo);
  return { ok: true, redirectTo: input.redirectTo };
}
