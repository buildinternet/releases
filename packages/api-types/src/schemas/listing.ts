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
export type ListingOrgPointer = z.infer<typeof ListingOrgPointerSchema>;

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

/**
 * Ownership claim flow (#1947 epic item 2): a signed-in user proves control
 * of a listed domain via a well-known token file OR a DNS TXT record.
 */

export const ListingClaimBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
});
export type ListingClaimBody = z.infer<typeof ListingClaimBodySchema>;

export const ListingClaimVerifyBodySchema = z.strictObject({
  claimId: z.string().min(1),
});
export type ListingClaimVerifyBody = z.infer<typeof ListingClaimVerifyBodySchema>;

export const OrgClaimStatusSchema = z.enum(["pending", "verified", "expired"]);
export type OrgClaimStatus = z.infer<typeof OrgClaimStatusSchema>;

export const ClaimMethodSchema = z.enum(["well-known", "dns-txt"]);
export type ClaimMethod = z.infer<typeof ClaimMethodSchema>;

/**
 * `token` + `instructions` are only present while the claim is `pending` (or
 * on mint) — once verified there's nothing left to prove, and an expired
 * claim's token is stale.
 */
export const OrgClaimSchema = z.strictObject({
  id: z.string(),
  org: ListingOrgPointerSchema,
  status: OrgClaimStatusSchema,
  method: ClaimMethodSchema.optional(),
  token: z.string().optional(),
  createdAt: z.string(),
  verifiedAt: z.string().optional(),
  expiresAt: z.string(),
  instructions: z
    .strictObject({
      wellKnownUrl: z.string(),
      dnsRecordName: z.string(),
    })
    .optional(),
});
export type OrgClaim = z.infer<typeof OrgClaimSchema>;

export const ClaimCheckOutcomeSchema = z.enum(["ok", "mismatch", "unreachable"]);
export type ClaimCheckOutcome = z.infer<typeof ClaimCheckOutcomeSchema>;

export const ClaimVerifyResultSchema = z.strictObject({
  verified: z.boolean(),
  checked: z.strictObject({
    wellKnown: ClaimCheckOutcomeSchema,
    dnsTxt: ClaimCheckOutcomeSchema,
  }),
  claim: OrgClaimSchema,
});
export type ClaimVerifyResult = z.infer<typeof ClaimVerifyResultSchema>;

export const ListingClaimsResultSchema = z.strictObject({
  claims: z.array(OrgClaimSchema),
});
export type ListingClaimsResult = z.infer<typeof ListingClaimsResultSchema>;
