import { z } from "zod";

export const MediaItemSchema = z.object({
  type: z.enum(["image", "video", "gif"]),
  url: z.string(),
  alt: z.string().optional(),
  r2Url: z.string().optional(),
});

export const PaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  returned: z.number().int().min(0),
  totalItems: z.number().int().min(0).optional(),
  totalPages: z.number().int().min(0).optional(),
  hasMore: z.boolean(),
});

export const ListResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: PaginationSchema,
  });

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const StatsSchema = z.object({
  orgs: z.number().int().min(0),
  sources: z.number().int().min(0),
  releases: z.number().int().min(0),
  products: z.number().int().min(0),
});
