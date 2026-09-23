import type { AiLaneId, OpenRouterCatalogModel } from "@buildinternet/releases-api-types";
import { MARKETING_DECISION_MODEL } from "@releases/core-internal/ai-lane-models";

export function modelOptions(
  catalog: OpenRouterCatalogModel[],
  lane: AiLaneId,
  query: string,
): OpenRouterCatalogModel[] {
  const q = query.trim().toLowerCase();
  return catalog
    .filter(
      (m) =>
        (lane === "marketing" || m.id !== MARKETING_DECISION_MODEL) &&
        (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
    )
    .slice(0, 40);
}
