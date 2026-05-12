import { z } from "zod";
import { OverviewPageItemSchema, OverviewCitationSchema } from "./shared.js";

/**
 * Response shape returned by `GET /v1/orgs/:slug/overview` — the org-scoped
 * knowledge page with inline citations, or `null` when no overview has been
 * generated yet.
 */
export const OrgOverviewResponseSchema = OverviewPageItemSchema.extend({
  citations: z.array(OverviewCitationSchema).optional(),
}).nullable();

/**
 * Body accepted by `POST /v1/orgs/:slug/overview` — the agent-authored
 * markdown content, the release count it was derived from, the timestamp of
 * the most-recent contributing release, and optional inline citations.
 */
export const RegenerateOverviewBodySchema = z.object({
  content: z.string(),
  releaseCount: z.number().int().min(0),
  lastContributingReleaseAt: z.string().nullable().optional(),
  citations: z.array(z.unknown()).optional(),
});

/** Response returned by `POST /v1/orgs/:slug/overview` on success. */
export const RegenerateOverviewResponseSchema = z.object({
  ok: z.literal(true),
  citations: z.number().int().min(0),
});

/**
 * Response shape returned by `GET /v1/products/:slug/overview` — the
 * product-scoped knowledge page, or `null` when no overview exists.
 * Does not include inline citations (products overview does not store them).
 */
export const ProductOverviewResponseSchema = OverviewPageItemSchema.nullable();

/**
 * Pre-flight payload returned by `GET /v1/orgs/:slug/overview/inputs?check=true`.
 * Lets an orchestrator decide whether to dispatch a per-org sub-agent without
 * paying for the full release-content hydration.
 */
export const OverviewInputsCheckResponseSchema = z.object({
  orgSlug: z.string(),
  selected: z.number().int().min(0),
  totalAvailable: z.number().int().min(0),
  hasExistingContent: z.boolean(),
  wouldRegenerate: z.boolean(),
  windowDays: z.number().int().min(1),
});

/**
 * Full inputs payload returned by `GET /v1/orgs/:slug/overview/inputs` (without
 * `?check=true`). Contains org metadata, active sources, the existing overview
 * content if any, and the selected hydrated releases ready for the AI model.
 *
 * Typed loosely because the release shape includes hydrated media URLs that
 * differ slightly from `ReleaseItem` — this avoids tight coupling to internal
 * fields while still surfacing the discriminating top-level structure.
 */
export const OverviewInputsFullResponseSchema = z.object({
  org: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    discovery: z.string(),
  }),
  sources: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      type: z.string(),
    }),
  ),
  existingContent: z.string().nullable(),
  selected: z.array(z.unknown()),
  totalAvailable: z.number().int().min(0),
  windowDays: z.number().int().min(1),
});

/**
 * Response returned by `GET /v1/orgs/:slug/playbook` — the playbook knowledge
 * page (scope `"playbook"`), or `null` when no playbook exists for the org.
 *
 * The playbook `content` field holds a deterministic markdown header generated
 * by `generatePlaybookHeader()` from `@releases/ai-internal/playbook`.
 */
export const PlaybookResponseSchema = OverviewPageItemSchema.extend({
  scope: z.literal("playbook").or(z.string()),
  notes: z.string().nullable().optional(),
}).nullable();

/** Body accepted by `PATCH /v1/orgs/:slug/playbook/notes`. */
export const UpdatePlaybookNotesBodySchema = z.object({
  notes: z.string(),
});

/** Response returned by `PATCH /v1/orgs/:slug/playbook/notes` on success. */
export const UpdatePlaybookNotesResponseSchema = z.object({
  ok: z.literal(true),
  notes: z.string().nullable(),
});
