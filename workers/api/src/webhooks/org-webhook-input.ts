/**
 * Shared webhook create/patch input validation, used by both the personal
 * (`/v1/me/webhooks`) and workspace (`/v1/workspaces/:workspaceId/webhooks`)
 * subscription routes. Keeping this in one place means both routes reject
 * the same bad input with byte-identical messages/codes, and org+source+
 * product resolution logic isn't duplicated.
 */
import { parseWebhookFormat, type WebhookFormat } from "@buildinternet/releases-core/schema";
import { assertPublicWebhookTarget, validateFormatWebhookUrl } from "./url-safety.js";
import {
  resolveWebhookOrg,
  resolveWebhookProduct,
  resolveWebhookSource,
  sourceProductFilterMismatch,
} from "./user-queries.js";
import { parseReleaseTypeFilter } from "./subscription-match.js";
import type { D1Db } from "../db.js";
import { NotFoundError, ValidationError, type ReleasesError } from "@releases/lib/releases-error";

const encoder = new TextEncoder();

export interface WebhookCommonFields {
  url: string;
  format: WebhookFormat;
  description: string | null;
}

/** Validates url/description/format shared by every create path (follows or org, personal or workspace). */
export async function parseWebhookCommonFields(
  body: Record<string, unknown>,
): Promise<WebhookCommonFields | ReleasesError> {
  const url = body.url;
  if (typeof url !== "string" || !url) {
    return new ValidationError("url is required", { code: "bad_request" });
  }
  if (encoder.encode(url).byteLength > 2048) {
    return new ValidationError("url must be at most 2048 bytes", { code: "bad_request" });
  }
  const description = typeof body.description === "string" ? body.description : null;
  if (description && encoder.encode(description).byteLength > 1000) {
    return new ValidationError("description must be at most 1000 bytes", { code: "bad_request" });
  }
  // SSRF check runs before format parsing — preserves the original
  // /v1/me/webhooks error precedence.
  const urlError = await assertPublicWebhookTarget(url);
  if (urlError) return new ValidationError(urlError, { code: "bad_request" });
  const format = parseWebhookFormat(body.format);
  if (format === null) {
    return new ValidationError("format must be 'json', 'slack', or 'discord'", {
      code: "bad_request",
    });
  }
  const formatUrlError = validateFormatWebhookUrl(format, url);
  if (formatUrlError) return new ValidationError(formatUrlError, { code: "bad_request" });
  return { url, format, description };
}

export interface OrgWebhookScopeFields {
  org: { id: string; slug: string; name: string };
  resolvedSourceId: string | null;
  resolvedProductId: string | null;
  releaseType: "feature" | "rollup" | null;
}

/** Resolve org/source/product + releaseType for an org-scoped create. */
export async function resolveOrgWebhookScopeFields(
  db: D1Db,
  body: Record<string, unknown>,
): Promise<OrgWebhookScopeFields | ReleasesError> {
  const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
  const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug : undefined;
  if (!orgId && !orgSlug) {
    return new ValidationError("orgId or orgSlug is required", { code: "bad_request" });
  }

  const org = await resolveWebhookOrg(db, { orgId, orgSlug });
  if (!org) return new NotFoundError("Organization not found");

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
  const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
  const productId = typeof body.productId === "string" ? body.productId : undefined;
  const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
  const releaseTypeFilter = parseReleaseTypeFilter(body.releaseType);
  if (releaseTypeFilter === "invalid") {
    return new ValidationError("releaseType must be feature or rollup", { code: "bad_request" });
  }

  let resolvedSourceId: string | null = null;
  let resolvedSourceProductId: string | null = null;
  if (sourceId || sourceSlug) {
    const source = await resolveWebhookSource(db, org.id, { sourceId, sourceSlug });
    if (!source) return new NotFoundError("Source not found for this organization");
    resolvedSourceId = source.id;
    resolvedSourceProductId = source.productId;
  }

  let resolvedProductId: string | null = null;
  if (productId || productSlug) {
    const product = await resolveWebhookProduct(db, org.id, { productId, productSlug });
    if (!product) return new NotFoundError("Product not found for this organization");
    resolvedProductId = product.id;
  }

  if (sourceProductFilterMismatch(resolvedSourceProductId, resolvedProductId)) {
    return new ValidationError("source does not belong to the specified product filter", {
      code: "bad_request",
    });
  }

  return { org, resolvedSourceId, resolvedProductId, releaseType: releaseTypeFilter };
}

export interface OrgWebhookPatchFilterResult {
  sourceId?: string | null;
  productId?: string | null;
}

/** Resolve source/product patch fields for an org-scoped PATCH (shared by personal + workspace routes). */
export async function resolveOrgWebhookPatchFilters(
  db: D1Db,
  owned: { orgId: string | null; sourceId: string | null; productId: string | null },
  body: Record<string, unknown>,
): Promise<OrgWebhookPatchFilterResult | ReleasesError> {
  let nextSourceId = owned.sourceId;
  let nextSourceProductId: string | null = null;
  if (body.sourceId !== undefined || body.sourceSlug !== undefined) {
    if (body.sourceId === null && body.sourceSlug === undefined) {
      nextSourceId = null;
    } else {
      const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
      const sourceSlug = typeof body.sourceSlug === "string" ? body.sourceSlug : undefined;
      if (!owned.orgId) return new ValidationError("invalid subscription", { code: "bad_request" });
      const source = await resolveWebhookSource(db, owned.orgId, { sourceId, sourceSlug });
      if (!source) return new NotFoundError("Source not found for this organization");
      nextSourceId = source.id;
      nextSourceProductId = source.productId;
    }
  } else if (nextSourceId && owned.orgId) {
    const source = await resolveWebhookSource(db, owned.orgId, { sourceId: nextSourceId });
    nextSourceProductId = source?.productId ?? null;
  }

  let nextProductId = owned.productId;
  if (body.productId !== undefined || body.productSlug !== undefined) {
    if (body.productId === null && body.productSlug === undefined) {
      nextProductId = null;
    } else if (!owned.orgId) {
      return new ValidationError("invalid subscription", { code: "bad_request" });
    } else {
      const productId = typeof body.productId === "string" ? body.productId : undefined;
      const productSlug = typeof body.productSlug === "string" ? body.productSlug : undefined;
      const product = await resolveWebhookProduct(db, owned.orgId, { productId, productSlug });
      if (!product) return new NotFoundError("Product not found for this organization");
      nextProductId = product.id;
    }
  }

  if (sourceProductFilterMismatch(nextSourceProductId, nextProductId)) {
    return new ValidationError("source does not belong to the specified product filter", {
      code: "bad_request",
    });
  }

  const result: OrgWebhookPatchFilterResult = {};
  if (body.sourceId !== undefined || body.sourceSlug !== undefined) result.sourceId = nextSourceId;
  if (body.productId !== undefined || body.productSlug !== undefined)
    result.productId = nextProductId;
  return result;
}
