import { z } from "zod";

export const AiLaneIdSchema = z.enum(["summarize", "extract", "feed-enrich", "marketing"]);

const ModelIdOrClearSchema = z.string().max(200).nullable().optional();

/** PUT /v1/ai/models — partial map; `null` or `""` clears that lane's override. */
export const AiLaneModelsPutSchema = z
  .object({
    models: z
      .object({
        summarize: ModelIdOrClearSchema,
        extract: ModelIdOrClearSchema,
        "feed-enrich": ModelIdOrClearSchema,
        marketing: ModelIdOrClearSchema,
      })
      .refine((m) => Object.values(m).some((v) => v !== undefined), {
        message: "at least one lane is required",
      }),
  })
  .strict();

export const AiLaneStateSchema = z.object({
  id: AiLaneIdSchema,
  label: z.string(),
  description: z.string(),
  envVar: z.string(),
  wranglerDefault: z.string().nullable(),
  override: z.string().nullable(),
  effective: z.string().nullable(),
});

export const OpenRouterCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number().nullable(),
  promptPricePerMillion: z.number().nullable(),
  completionPricePerMillion: z.number().nullable(),
  vision: z.boolean(),
});

/** GET /v1/ai/models — current assignments plus the OpenRouter catalog. */
export const AiLaneModelsResponseSchema = z.object({
  lanes: z.array(AiLaneStateSchema),
  catalog: z.array(OpenRouterCatalogModelSchema),
  catalogFetchedAt: z.string().nullable(),
  catalogError: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
