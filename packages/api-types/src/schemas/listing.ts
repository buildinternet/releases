import { z } from "zod";

/**
 * Public wire contract for the self-serve listing lane (#1947 phase 2):
 * POST /v1/listing/validate and POST /v1/listing/activate. This projection is
 * deliberately independent of the internal materialization plan — it is the
 * stable shape web/CLI consume while internals stay free to change.
 */

export const ListingValidateBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
});
export type ListingValidateBody = z.infer<typeof ListingValidateBodySchema>;

export const ListingActivateBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
  requestTracking: z.boolean().optional(),
});
export type ListingActivateBody = z.infer<typeof ListingActivateBodySchema>;

export const ListingIssueSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});
export type ListingIssue = z.infer<typeof ListingIssueSchema>;

export const ListingLocationSchema = z.strictObject({
  /** The declared locator value (feed URL, github ref, url, appstore id, file). */
  locator: z.string(),
  kind: z.enum(["feed", "github", "appstore", "url", "file"]),
  classification: z.enum(["tier1-live", "tier2-paused-review"]),
  /** Plain-English "what this becomes" for the preview UI. */
  becomes: z.string(),
  /** Present when the locator is nested under a manifest product. */
  productName: z.string().optional(),
});
export type ListingLocation = z.infer<typeof ListingLocationSchema>;

export const ListingOrgPointerSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  webUrl: z.string(),
});

export const ListingValidationResultSchema = z.strictObject({
  valid: z.boolean(),
  errors: z.array(ListingIssueSchema),
  domainStatus: z.enum(["unlisted", "listed", "stub"]),
  /** Present when domainStatus is "listed" or "stub". */
  org: ListingOrgPointerSchema.optional(),
  /** Present when valid: identity fields as they would land. */
  identity: z
    .strictObject({
      name: z.string(),
      slug: z.string(),
      domain: z.string(),
    })
    .optional(),
  products: z.array(z.strictObject({ name: z.string(), locationCount: z.number() })).optional(),
  locations: z.array(ListingLocationSchema),
});
export type ListingValidationResult = z.infer<typeof ListingValidationResultSchema>;

export const ListingActivateResultSchema = z.strictObject({
  /** True when this call created the stub; false for the existing-stub carve-out. */
  activated: z.boolean(),
  org: z.strictObject({
    slug: z.string(),
    name: z.string(),
    status: z.enum(["stub", "tracked"]),
    webUrl: z.string(),
  }),
  trackingRequested: z.boolean(),
});
export type ListingActivateResult = z.infer<typeof ListingActivateResultSchema>;
