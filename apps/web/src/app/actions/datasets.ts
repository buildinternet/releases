"use server";

import {
  SourceDatasetSettingsSchema,
  type AdminDatasetsResponse,
  type SourceDatasetSettings,
} from "@buildinternet/releases-api-types/datasets";
import { adminActionEnv } from "@/lib/admin-action";
import { webApiHeaders } from "@/lib/api";

type DatasetResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getAdminDatasetsAction(
  query = "",
  page = 1,
): Promise<DatasetResult<AdminDatasetsResponse>> {
  try {
    const env = await adminActionEnv();
    if ("error" in env) return { ok: false, error: env.error };
    const params = new URLSearchParams({
      q: query.trim(),
      page: String(Number.isSafeInteger(page) && page > 0 ? page : 1),
      limit: "20",
    });
    const res = await fetch(`${env.apiUrl}/v1/admin/datasets?${params}`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.bearer}` }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `Could not load datasets (API ${res.status}).` };
    return { ok: true, data: (await res.json()) as AdminDatasetsResponse };
  } catch {
    return { ok: false, error: "Could not load datasets. Check the connection and try again." };
  }
}

export async function setSourceDatasetAction(
  sourceId: string,
  settings: SourceDatasetSettings | null,
): Promise<DatasetResult<null>> {
  if (!sourceId.startsWith("src_")) return { ok: false, error: "Invalid source ID." };
  const parsed = settings === null ? null : SourceDatasetSettingsSchema.safeParse(settings);
  if (parsed && !parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(" ") };
  }
  try {
    const env = await adminActionEnv();
    if ("error" in env) return { ok: false, error: env.error };
    const res = await fetch(`${env.apiUrl}/v1/sources/${encodeURIComponent(sourceId)}/metadata`, {
      method: "PATCH",
      headers: webApiHeaders({
        Authorization: `Bearer ${env.bearer}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ dataset: parsed?.success ? parsed.data : null }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return { ok: false, error: body?.error?.message || `Could not save (API ${res.status}).` };
    }
    return { ok: true, data: null };
  } catch {
    return {
      ok: false,
      error: "The save could not be confirmed. Refresh to check the source before trying again.",
    };
  }
}
