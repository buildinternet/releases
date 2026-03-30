import { getSourceMeta } from "../adapters/feed.js";
import type { Source, Organization } from "../db/schema.js";
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
 */
export async function isSummarizationEnabled(source: Source): Promise<boolean> {
  // Source-level opt-out
  const sourceMeta = getSourceMeta(source);
  if (sourceMeta.summarize === false) return false;

  // Org-level opt-out
  if (source.orgId) {
    const org = await getOrgById(source.orgId);
    if (org) {
      const orgMeta = getOrgMeta(org);
      if (orgMeta.summarize === false) return false;
    }
  }

  return true;
}
