"use server";

import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";
import {
  submissionsQueryString,
  type SubmissionsQuery,
  type SubmissionsResponse,
} from "@/lib/admin-submissions";

type ListResult = { ok: true; data: SubmissionsResponse } | { ok: false; error: string };
type TriageResult = { ok: true } | { ok: false; error: string };

export async function listSubmissionsAction(query: SubmissionsQuery = {}): Promise<ListResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };
  try {
    const res = await fetch(`${env.apiUrl}/v1/admin/submissions${submissionsQueryString(query)}`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.bearer}` }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
    }
    return { ok: true, data: (await res.json()) as SubmissionsResponse };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Triage a recommendation or feedback row through its existing admin PATCH
 * route (`/v1/recommendations/:id`, `/v1/feedback/:id`) — no new write path.
 */
export async function triageSubmissionAction(
  kind: "recommendation" | "feedback",
  id: string,
  patch: { status?: "new" | "triaged" | "closed"; archived?: boolean },
): Promise<TriageResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };
  const base = kind === "recommendation" ? "recommendations" : "feedback";
  try {
    const res = await fetch(`${env.apiUrl}/v1/${base}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.bearer}`,
      }),
      body: JSON.stringify(patch),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}
