import { z } from "zod";
import { CategorySchema, ListResponseSchema, OverviewPageItemSchema } from "./shared.js";
import { SourceListItemSchema } from "./sources.js";
import { ProductListItemSchema } from "./products.js";

export const OrgListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
  category: CategorySchema.nullable(),
  avatarUrl: z.string().nullable(),
  sourceCount: z.number().int().min(0),
  releaseCount: z.number().int().min(0),
  recentReleaseCount: z.number().int().min(0),
  lastActivity: z.string().nullable(),
  topProducts: z.array(z.string()),
  sparkline: z.array(z.number().int().min(0)).length(30),
});

export const OrgListResponseSchema = ListResponseSchema(OrgListItemSchema);

export const OrgAccountItemSchema = z.object({
  platform: z.string(),
  handle: z.string(),
});

export const OrgAccountsResponseSchema = ListResponseSchema(OrgAccountItemSchema);
export const OrgTagsResponseSchema = ListResponseSchema(z.string());

export const CreateOrgBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  domain: z.string().optional(),
  description: z.string().optional(),
  category: CategorySchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const UpdateOrgBodySchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  domain: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: CategorySchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});

// Org detail's products query selects a strict subset of `ProductListItem` —
// no category/orgId/createdAt because the parent already names the org and
// the org detail UI doesn't surface those columns.
const OrgDetailProductSchema = ProductListItemSchema.pick({
  id: true,
  slug: true,
  name: true,
  url: true,
  description: true,
  sourceCount: true,
});

const OrgDetailPlaybookSchema = z.object({
  scope: z.literal("playbook"),
  content: z.string(),
  updatedAt: z.string(),
});

export const OrgDetailSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  description: z.string().nullable().optional(),
  category: CategorySchema.nullable().optional(),
  avatarUrl: z.string().nullable(),
  tags: z.array(z.string()).optional(),
  sourceCount: z.number().int().min(0),
  releaseCount: z.number().int().min(0),
  releasesLast30Days: z.number().int().min(0),
  avgReleasesPerWeek: z.number(),
  lastFetchedAt: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  trackingSince: z.string(),
  aliases: z.array(z.string()).optional(),
  accounts: z.array(OrgAccountItemSchema),
  products: z.array(OrgDetailProductSchema),
  sources: z.array(SourceListItemSchema),
  overview: OverviewPageItemSchema.nullable().optional(),
  playbook: OrgDetailPlaybookSchema.nullable().optional(),
});
