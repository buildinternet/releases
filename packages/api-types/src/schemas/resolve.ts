import { z } from "zod";
import { ProductDetailSchema } from "./products.js";
import { SourceDetailSchema } from "./sources.js";

/**
 * Response of `GET /v1/orgs/:org/resolve/:slug` (#1190). Product-first: when a
 * product and a source share a slug in an org, the product variant is returned.
 * A 404 (ErrorResponse) is returned when neither matches.
 */
export const ResolveResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), product: ProductDetailSchema }),
  z.object({ kind: z.literal("source"), source: SourceDetailSchema }),
]);

export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
