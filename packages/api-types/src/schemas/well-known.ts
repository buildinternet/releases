import { z } from "zod";

const MAX_PRODUCTS = 24;
const MAX_PRODUCT_RELEASES = 8;
const MAX_FILE_RELEASES = 32;

/** A single social handle/URL. Bare handles are intentionally accepted. */
const SocialValueSchema = z.string().min(1).max(200);
const SocialSchema = z.record(z.string().min(1).max(40), SocialValueSchema);

const HttpsUrlSchema = z
  .url()
  .refine((url) => url.startsWith("https://"), "locator must be an https URL");

const ReleaseLocationFields = {
  url: HttpsUrlSchema.optional(),
  feed: HttpsUrlSchema.optional(),
  appstore: HttpsUrlSchema.optional(),
  file: HttpsUrlSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  canonical: z.boolean().optional(),
};

function hasLocator(value: {
  url?: string;
  feed?: string;
  github?: string;
  appstore?: string;
  file?: string;
}): boolean {
  return Boolean(value.url || value.feed || value.github || value.appstore || value.file);
}

/** A domain manifest can name a concrete GitHub repository, but never `self`. */
export const ReleasesJsonDomainReleaseSchema = z
  .strictObject({
    ...ReleaseLocationFields,
    github: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "github must be owner/repo")
      .optional(),
  })
  .refine(hasLocator, "at least one release locator is required");

/** A repo manifest additionally accepts `github: "self"`. */
export const ReleasesJsonRepoReleaseSchema = z
  .strictObject({
    ...ReleaseLocationFields,
    github: z
      .union([
        z.literal("self"),
        z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "github must be owner/repo"),
      ])
      .optional(),
  })
  .refine(hasLocator, "at least one release locator is required");

function releasesArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine(
      (items) =>
        items.filter((entry) => Boolean((entry as { canonical?: boolean }).canonical)).length <= 1,
      "at most one canonical release location is allowed per scope",
    );
}

const DomainProductReleasesSchema = releasesArray(
  ReleasesJsonDomainReleaseSchema,
  MAX_PRODUCT_RELEASES,
);
const RepoReleasesSchema = releasesArray(ReleasesJsonRepoReleaseSchema, MAX_FILE_RELEASES);
const DomainReleasesSchema = releasesArray(ReleasesJsonDomainReleaseSchema, MAX_FILE_RELEASES);

/**
 * Product declaration in a domain manifest. Taxonomy strings are deliberately
 * lenient here; the reconciler resolves known values and ignores the rest.
 */
export const ReleasesJsonProductSchema = z.strictObject({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
  kind: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  website: z.url().optional(),
  docs: z.url().optional(),
  support: z.url().optional(),
  social: SocialSchema.optional(),
  archived: z.boolean().optional(),
  releases: DomainProductReleasesSchema.optional(),
});

/** Repo-scope product binding. Slug is only a creation suggestion. */
export const ReleasesJsonRepoProductSchema = z.strictObject({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
});

const ReleasesRegistrySchema = z
  .object({
    org: z
      .string()
      .regex(/^org_[A-Za-z0-9]+$/)
      .optional(),
    product: z
      .string()
      .regex(/^prd_[A-Za-z0-9]+$/)
      .optional(),
    verification: z.string().min(1).max(500).optional(),
  })
  .catchall(z.unknown());

/** Registry-specific extensions are forward-compatible by design. */
export const ReleasesJsonRegistriesSchema = z
  .object({
    "releases.sh": ReleasesRegistrySchema.optional(),
  })
  .catchall(z.unknown());

/** Top-level fields shared by every manifest scope. */
const BaseFields = {
  $schema: z.url().optional(),
  version: z.literal(2),
  registries: ReleasesJsonRegistriesSchema.optional(),
};

const CommonFields = {
  ...BaseFields,
  releases: DomainReleasesSchema.optional(),
};

/** Domain-hosted variant: flat org identity plus product and release declarations. */
export const ReleasesJsonDomainSchema = z
  .strictObject({
    ...CommonFields,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().min(1).max(120).optional(),
    avatar: HttpsUrlSchema.optional(),
    tags: z.array(z.string().min(1).max(60)).max(50).optional(),
    social: SocialSchema.optional(),
    products: z.array(ReleasesJsonProductSchema).max(MAX_PRODUCTS).optional(),
  })
  .refine(
    (manifest) =>
      (manifest.releases?.length ?? 0) +
        (manifest.products?.reduce((sum, product) => sum + (product.releases?.length ?? 0), 0) ??
          0) <=
      MAX_FILE_RELEASES,
    `at most ${MAX_FILE_RELEASES} release locations are allowed per file`,
  );

/** Repo-root variant: product binding plus repo-scoped release declarations. */
export const ReleasesJsonRepoSchema = z.strictObject({
  ...BaseFields,
  product: ReleasesJsonRepoProductSchema.optional(),
  releases: RepoReleasesSchema.optional(),
});

/** Public schema accepts either hosting scope; reconcilers use the scoped schema. */
export const ReleasesJsonConfigSchema = z.union([ReleasesJsonDomainSchema, ReleasesJsonRepoSchema]);

export type ReleasesJsonConfig = z.infer<typeof ReleasesJsonConfigSchema>;
export type ReleasesJsonDomain = z.infer<typeof ReleasesJsonDomainSchema>;
export type ReleasesJsonRepo = z.infer<typeof ReleasesJsonRepoSchema>;
export type ReleasesJsonProduct = z.infer<typeof ReleasesJsonProductSchema>;
export type ReleasesJsonDomainRelease = z.infer<typeof ReleasesJsonDomainReleaseSchema>;
export type ReleasesJsonRepoRelease = z.infer<typeof ReleasesJsonRepoReleaseSchema>;

/**
 * Body for `POST /v1/orgs/stub` — curator-authored stub org (#1947). Mirrors
 * the domain-manifest identity + product + locator shape (so a curator can hand
 * the same declaration a manifest would carry), minus manifest-transport fields
 * (`version`/`$schema`/`registries`) and plus the registry-identity fields a
 * stub org needs to be resolvable (`slug`/`domain`). Locators are optional — an
 * identity-only stub (locations TBD) is valid. `category`/taxonomy strings stay
 * lenient; the route resolves them and ignores the rest, same as the reconciler.
 */
export const CreateStubOrgBodySchema = z.strictObject({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
  domain: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().min(1).max(120).optional(),
  avatar: HttpsUrlSchema.optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  social: SocialSchema.optional(),
  products: z.array(ReleasesJsonProductSchema).max(MAX_PRODUCTS).optional(),
  releases: DomainReleasesSchema.optional(),
});

export type CreateStubOrgBody = z.infer<typeof CreateStubOrgBodySchema>;

/**
 * Body for `POST /v1/orgs/stub-from-domain` (#1947) — the unlisted-domain path.
 * The worker fetches https://{domain}/.well-known/releases.json and, if valid
 * and the domain has no org yet, creates a stub org + declared locators.
 */
export const StubFromDomainBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
});

export type StubFromDomainBody = z.infer<typeof StubFromDomainBodySchema>;

/** Response shape of POST /v1/orgs/:slug/sync-well-known. */
export const SyncWellKnownResponseSchema = z.object({
  fetched: z.boolean(),
  applied: z.boolean(),
  skippedReason: z.string().optional(),
  plan: z.unknown().optional(),
});
