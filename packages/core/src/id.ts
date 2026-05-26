import { nanoid } from "nanoid";

export const newSourceId = () => `src_${nanoid()}`;
export const newReleaseId = () => `rel_${nanoid()}`;
export const newOrgId = () => `org_${nanoid()}`;
export const newOrgAccountId = () => `oa_${nanoid()}`;
export const newFetchLogId = () => `fl_${nanoid()}`;
export const newIgnoredUrlId = () => `iu_${nanoid()}`;
export const newBlockedUrlId = () => `bu_${nanoid()}`;
export const newSummaryId = () => `sum_${nanoid()}`;
export const newMediaAssetId = () => `ma_${nanoid()}`;
export const newProductId = () => `prod_${nanoid()}`;
export const newTagId = () => `tag_${nanoid()}`;
export const newDomainAliasId = () => `da_${nanoid()}`;
export const newKnowledgePageId = () => `kp_${nanoid()}`;
export const newKnowledgePageCitationId = () => `kpc_${nanoid()}`;
export const newSourceChangelogFileId = () => `scf_${nanoid()}`;
export const newSourceChangelogChunkId = () => `scc_${nanoid()}`;
export const newCorrelationId = () => `cid_${nanoid()}`;
export const newCronRunId = () => `crun_${nanoid()}`;
export const newTelemetryEventId = () => `tel_${nanoid()}`;
export const newSearchQueryId = () => `sq_${nanoid()}`;
export const newCollectionId = () => `col_${nanoid()}`;
export const newBatchRunId = () => `bat_${nanoid()}`;
export function newWebhookSubscriptionId(): string {
  return `whk_${nanoid(16)}`;
}
export const newLocalEventId = () => `levt_${nanoid()}`;
export const newApiTokenId = () => `tok_${nanoid()}`;
export const newFeedbackId = () => `fb_${nanoid()}`;
export const newRecommendationId = () => `rec_${nanoid()}`;

export type EntityType = "release" | "source" | "org" | "product" | "unknown";

const ID_PREFIXES: Record<string, EntityType> = {
  rel_: "release",
  src_: "source",
  org_: "org",
  prod_: "product",
};

// nanoid() default alphabet is A-Za-z0-9_- and length 21
const BARE_NANOID = /^[A-Za-z0-9_-]{21}$/;

export function isLikelyBareId(s: string): boolean {
  return BARE_NANOID.test(s);
}

export function getEntityType(id: string): EntityType {
  for (const [prefix, type] of Object.entries(ID_PREFIXES)) {
    if (id.startsWith(prefix)) return type;
  }
  return "unknown";
}

/**
 * Normalize a release ID. Accepts `rel_<nanoid>` or a bare `<nanoid>` and
 * returns the prefixed form. Strings that already look like a different
 * entity (e.g. `src_...`) are returned as-is so callers can decide what to
 * do with them.
 */
export function normalizeReleaseId(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("rel_")) return trimmed;
  if (getEntityType(trimmed) !== "unknown") return trimmed;
  if (BARE_NANOID.test(trimmed)) return `rel_${trimmed}`;
  return trimmed;
}
