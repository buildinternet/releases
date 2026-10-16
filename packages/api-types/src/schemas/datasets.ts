import { z } from "zod";

export const DatasetDescriptionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(50).max(5000),
});

/** Stored under source.metadata.dataset. Null removes the override. */
export const SourceDatasetSettingsSchema = DatasetDescriptionSchema.partial()
  .extend({
    enabled: z.boolean().optional(),
  })
  .strict();
export type SourceDatasetSettings = z.infer<typeof SourceDatasetSettingsSchema>;
export type DatasetDescription = z.infer<typeof DatasetDescriptionSchema>;
export interface AdminDatasetSource {
  id: string;
  slug: string;
  name: string;
  orgSlug: string | null;
  orgName: string | null;
  defaultEnabled: boolean;
  settings: SourceDatasetSettings | null;
  effective: DatasetDescription | null;
  blockedReasons: string[];
}
export interface AdminDatasetsResponse {
  sources: AdminDatasetSource[];
  pagination: { page: number; limit: number; hasMore: boolean };
  query: string;
}
