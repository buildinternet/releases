---
"@buildinternet/releases-api-types": minor
---

Add Zod schemas for follows and the personalized feed (`FollowSchema`, `FollowsListResponseSchema`, `FollowRequestSchema`, `FollowMutationResponseSchema`, `PersonalizedFeedResponseSchema`), webhook reads, updates and deliveries (`UserWebhookSchema`, `WorkspaceWebhookSchema`, `UpdateWebhookBodySchema`, `WebhookDeliveryRowSchema`, `WebhookDeliveriesResponseSchema`), and API key revocation (`RevokeUserApiKeyResponseSchema`). The existing type names are now inferred from these schemas.
