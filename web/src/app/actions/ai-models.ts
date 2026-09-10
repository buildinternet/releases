"use server";

import type { AiLaneId, AiLaneModelsResponse } from "@buildinternet/releases-api-types";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true; data: AiLaneModelsResponse } | { ok: false; error: string };

export async function getAiLaneModelsAction(): Promise<AiLaneModelsResponse | null> {
  const env = await adminActionEnv();
  if ("error" in env) return null;
  try {
    const res = await fetch(`${env.apiUrl}/v1/ai/models`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.bearer}` }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as AiLaneModelsResponse;
  } catch {
    return null;
  }
}

export async function setAiLaneModelAction(
  lane: AiLaneId,
  modelId: string | null,
): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/ai/models`, {
      method: "PUT",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.bearer}`,
      }),
      body: JSON.stringify({ models: { [lane]: modelId } }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }
  return { ok: true, data: (await res.json()) as AiLaneModelsResponse };
}
