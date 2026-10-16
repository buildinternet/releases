import {
  resolveSourceDataset,
  type DatasetSourceRef,
} from "@releases/core-internal/source-dataset";
export { sourceDatasetEligible } from "@releases/core-internal/source-dataset";

/** The same persisted override/default resolution backs every public surface. */
export function getSourceDatasetPilot(
  orgSlug: string,
  sourceSlug: string,
  source: Omit<DatasetSourceRef, "orgSlug" | "slug"> = {},
) {
  return resolveSourceDataset({ ...source, orgSlug, slug: sourceSlug });
}
