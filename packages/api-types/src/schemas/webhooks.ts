import { z } from "zod";
import { WEBHOOK_FORMATS, WEBHOOK_SCOPES } from "@buildinternet/releases-core/schema";
import { ReleaseTypeSchema } from "./shared.js";

/**
 * Self-serve webhook subscriptions: user-owned (`/v1/me/webhooks`) and
 * workspace-owned (`/v1/workspaces/:workspaceId/webhooks`). Signing secrets
 * never appear on read paths — only once on create / rotate.
 */

/**
 * High-level delivery posture derived from summary columns (no AE query).
 * Mirrors `WebhookDeliveryHealth` in `@releases/core-internal/webhook-resilience`.
 */
export const WebhookDeliveryHealthSchema = z.enum([
  "never_delivered",
  "healthy",
  "degraded",
  "failing",
  "paused",
  "auto_paused",
]);

/** Self-serve webhook filter scope. */
export const UserWebhookScopeSchema = z.enum(WEBHOOK_SCOPES);

/** Optional per-event filter on release taxonomy type. */
export const UserWebhookReleaseTypeFilterSchema = ReleaseTypeSchema;

/** Webhook delivery output format. */
export const UserWebhookFormatSchema = z.enum(WEBHOOK_FORMATS);

/** A user-owned webhook subscription row (no signing secret). */
export const UserWebhookSubscriptionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  scope: UserWebhookScopeSchema,
  orgId: z.string().nullable(),
  url: z.string(),
  sourceId: z.string().nullable(),
  productId: z.string().nullable(),
  releaseType: UserWebhookReleaseTypeFilterSchema.nullable(),
  format: UserWebhookFormatSchema,
  enabled: z.boolean(),
  description: z.string().nullable(),
  secretVersion: z.number().int(),
  createdAt: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastErrorMsg: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  disabledReason: z.string().nullable(),
  failureStreakStartedAt: z.string().nullable(),
});

/** Delivery health fields returned on user webhook read paths. */
export const UserWebhookDeliveryHealthSchema = z.object({
  deliveryHealth: WebhookDeliveryHealthSchema,
  deliveryHealthSummary: z.string(),
});

/** List item returned by GET /v1/me/webhooks — includes org/source display fields. */
export const UserWebhookListItemSchema = UserWebhookSubscriptionSchema.omit({ userId: true })
  .extend(UserWebhookDeliveryHealthSchema.shape)
  .extend({
    orgSlug: z.string().nullable(),
    orgName: z.string().nullable(),
    sourceSlug: z.string().nullable(),
    sourceName: z.string().nullable(),
    productSlug: z.string().nullable(),
    productName: z.string().nullable(),
  });

/** GET /v1/me/webhooks response. */
export const UserWebhookListResponseSchema = z.object({
  subscriptions: z.array(UserWebhookListItemSchema),
});

/** Fields a create response adds to the stored row (user and workspace). */
const CreatedWebhookFields = {
  ...UserWebhookDeliveryHealthSchema.shape,
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  /** Shown once at creation; omitted for slack/discord. */
  signingKey: z.string().optional(),
};

/** POST /v1/me/webhooks response. */
export const CreateUserWebhookResponseSchema =
  UserWebhookSubscriptionSchema.extend(CreatedWebhookFields);

/** POST …/webhooks/:id/rotate-secret response (user and workspace). */
export const RotateUserWebhookSecretResponseSchema = z.object({
  secretVersion: z.number().int(),
  signingKey: z.string(),
});

/** POST …/webhooks/:id/test response (user and workspace). */
export const TestUserWebhookResponseSchema = z.object({
  enqueued: z.literal(true),
  eventId: z.string(),
});

/** Workspace member role (Better Auth `member.role`, not `user.role`). */
export const WorkspaceMemberRoleSchema = z.enum(["owner", "admin", "member"]);

/** Workspace webhooks are org-scoped only; there is no workspace follows scope. */
const WorkspaceOwnerFields = { workspaceId: z.string(), scope: z.literal("org") };

/** A workspace-owned webhook subscription row (no signing secret). */
export const WorkspaceWebhookSubscriptionSchema = UserWebhookSubscriptionSchema.omit({
  userId: true,
}).extend(WorkspaceOwnerFields);

/** List item returned by GET /v1/workspaces/:workspaceId/webhooks. */
export const WorkspaceWebhookListItemSchema =
  UserWebhookListItemSchema.extend(WorkspaceOwnerFields);

/** GET /v1/workspaces/:workspaceId/webhooks response. */
export const WorkspaceWebhookListResponseSchema = z.object({
  subscriptions: z.array(WorkspaceWebhookListItemSchema),
  /** The caller's role in the workspace. */
  role: WorkspaceMemberRoleSchema,
  /** True for owners and admins: create, edit, rotate, and delete. Members can view and test. */
  canManage: z.boolean(),
});

/** POST /v1/workspaces/:workspaceId/webhooks response. */
export const CreateWorkspaceWebhookResponseSchema =
  WorkspaceWebhookSubscriptionSchema.extend(CreatedWebhookFields);

/**
 * Fields shared by user and workspace webhook create bodies. Documentation
 * shape: the handler validates (SSRF-checks `url`, matches `format` to the
 * URL host) and resolves the org/source/product references.
 */
const WebhookCreateCommonFields = {
  url: z.string().max(2048).describe("Public https URL that receives deliveries."),
  format: UserWebhookFormatSchema.optional().describe("Delivery format. Defaults to `json`."),
  description: z.string().max(1000).optional(),
  releaseType: UserWebhookReleaseTypeFilterSchema.optional(),
};

/** Org/source/product targeting for an org-scoped webhook (`orgId` or `orgSlug` required). */
const WebhookOrgTargetFields = {
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  sourceId: z.string().optional(),
  sourceSlug: z.string().optional(),
  productId: z.string().optional(),
  productSlug: z.string().optional(),
};

/**
 * POST /v1/me/webhooks body. `scope: "follows"` delivers releases from
 * everything the caller follows and must not name an org/source/product;
 * the default `"org"` scope requires `orgId` or `orgSlug`.
 */
export const CreateUserWebhookBodySchema = z.object({
  scope: UserWebhookScopeSchema.optional(),
  ...WebhookCreateCommonFields,
  ...WebhookOrgTargetFields,
});

/** POST /v1/workspaces/:workspaceId/webhooks body — org-scoped only. */
export const CreateWorkspaceWebhookBodySchema = z.object({
  scope: z.literal("org").optional(),
  ...WebhookCreateCommonFields,
  ...WebhookOrgTargetFields,
});

export type WebhookDeliveryHealth = z.infer<typeof WebhookDeliveryHealthSchema>;
export type UserWebhookScope = z.infer<typeof UserWebhookScopeSchema>;
export type UserWebhookReleaseTypeFilter = z.infer<typeof UserWebhookReleaseTypeFilterSchema>;
export type UserWebhookFormat = z.infer<typeof UserWebhookFormatSchema>;
export type UserWebhookSubscription = z.infer<typeof UserWebhookSubscriptionSchema>;
export type UserWebhookDeliveryHealth = z.infer<typeof UserWebhookDeliveryHealthSchema>;
export type UserWebhookListItem = z.infer<typeof UserWebhookListItemSchema>;
export type UserWebhookListResponse = z.infer<typeof UserWebhookListResponseSchema>;
export type CreateUserWebhookResponse = z.infer<typeof CreateUserWebhookResponseSchema>;
export type RotateUserWebhookSecretResponse = z.infer<typeof RotateUserWebhookSecretResponseSchema>;
export type TestUserWebhookResponse = z.infer<typeof TestUserWebhookResponseSchema>;
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRoleSchema>;
export type WorkspaceWebhookSubscription = z.infer<typeof WorkspaceWebhookSubscriptionSchema>;
export type WorkspaceWebhookListItem = z.infer<typeof WorkspaceWebhookListItemSchema>;
export type WorkspaceWebhookListResponse = z.infer<typeof WorkspaceWebhookListResponseSchema>;
export type CreateWorkspaceWebhookResponse = z.infer<typeof CreateWorkspaceWebhookResponseSchema>;
export type CreateUserWebhookBody = z.infer<typeof CreateUserWebhookBodySchema>;
export type CreateWorkspaceWebhookBody = z.infer<typeof CreateWorkspaceWebhookBodySchema>;
