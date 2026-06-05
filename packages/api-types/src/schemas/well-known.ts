import { z } from "zod";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import { NoticeSchema } from "./shared.js";

/** A single social handle/URL. Bare handles allowed; URLs must be https. */
const SocialValueSchema = z.string().min(1).max(200);

/** Product-scope block: declares the hosting repo's source belongs to this product. */
export const ReleasesJsonProductSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    // Accepted leniently as a string; resolved/validated against CATEGORIES at apply time.
    category: z.string().min(1).max(120).optional(),
    kind: z.enum(KIND_VALUES).optional(),
  })
  .strict();

/**
 * One file name, two hosting scopes. Org-identity keys are honored only from a
 * domain `.well-known/releases.json`; `product` is honored only from a repo-root
 * file. The server enforces which keys it honors based on the host the file came
 * from — this schema only validates shape.
 */
export const ReleasesJsonConfigSchema = z
  .object({
    $schema: z.url().optional(),
    // Org scope
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().min(1).max(120).optional(),
    avatar: z
      .url()
      .refine((u) => u.startsWith("https://"), "avatar must be an https URL")
      .optional(),
    tags: z.array(z.string().min(1).max(60)).max(50).optional(),
    social: z.record(z.string().min(1).max(40), SocialValueSchema).optional(),
    notice: NoticeSchema.optional(),
    // Source/product scope
    product: ReleasesJsonProductSchema.optional(),
  })
  .strip();

export type ReleasesJsonConfig = z.infer<typeof ReleasesJsonConfigSchema>;
export type ReleasesJsonProduct = z.infer<typeof ReleasesJsonProductSchema>;

/** Response shape of POST /v1/orgs/:slug/sync-well-known. */
export const SyncWellKnownResponseSchema = z.object({
  fetched: z.boolean(),
  applied: z.boolean(),
  skippedReason: z.string().optional(),
  plan: z.unknown().optional(),
});
