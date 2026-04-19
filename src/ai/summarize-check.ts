import { getSourceMeta } from "../adapters/feed.js";
import type { Source, Organization } from "@releases/core-internal/schema";
import { getOrgById } from "../db/queries.js";

interface OrgMetadata {
  summarize?: boolean;
}

function getOrgMeta(org: Organization): OrgMetadata {
  try {
    return JSON.parse(org.metadata ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Returns true if summary generation is enabled for this source.
 * Check order: source metadata → org metadata → default (enabled).
 * Pass a pre-fetched org to avoid a redundant DB lookup.
 */
export async function isSummarizationEnabled(
  source: Source,
  org?: Organization | null,
): Promise<boolean> {
  // Source-level opt-out
  const sourceMeta = getSourceMeta(source);
  if (sourceMeta.summarize === false) return false;

  // Org-level opt-out
  if (source.orgId) {
    const resolvedOrg = org !== undefined ? org : await getOrgById(source.orgId);
    if (resolvedOrg) {
      const orgMeta = getOrgMeta(resolvedOrg);
      if (orgMeta.summarize === false) return false;
    }
  }

  return true;
}
