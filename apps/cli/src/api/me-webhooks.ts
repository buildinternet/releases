import type {
  CreateUserWebhookResponse,
  CreateWorkspaceWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookDeliveryHealth,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookReleaseTypeFilter,
  UserWebhookScope,
  UserWebhookSubscription,
  WebhookDeliveryRow,
  WorkspaceMemberRole,
  WorkspaceWebhookListItem,
  WorkspaceWebhookSubscription,
} from "@buildinternet/releases-api-types";
import type { Releases } from "@buildinternet/releases-sdk";
import { call, find } from "./sdk.js";

export type {
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookReleaseTypeFilter,
  UserWebhookScope,
  UserWebhookSubscription,
  WebhookDeliveryRow,
  WorkspaceMemberRole,
  WorkspaceWebhookListItem,
  WorkspaceWebhookSubscription,
} from "@buildinternet/releases-api-types";

/**
 * Who the webhook subscription belongs to. `user` hits `/v1/me/webhooks`
 * (the caller's own subscriptions); `workspace` hits
 * `/v1/workspaces/:id/webhooks` (a Better Auth workspace's shared
 * subscriptions — org-scoped only, see releases-cli#406). Every function
 * below takes the base path as a parameter instead of duplicating each verb
 * for the two owners.
 */
export type WebhookOwner = { kind: "user" } | { kind: "workspace"; id: string };

export const MY_WEBHOOKS: WebhookOwner = { kind: "user" };

/**
 * The SDK resource for an owner's subscriptions. Both owners expose the same
 * verbs; the casts only widen the owner-specific body and response types to
 * the unions this module already speaks in.
 */
function hooks(c: Releases, owner: WebhookOwner) {
  return (owner.kind === "workspace"
    ? c.workspaceWebhooks(owner.id)
    : c.me.webhooks) as unknown as {
    list(query?: { enabled?: boolean }): Promise<{
      subscriptions: AnyWebhookListItem[];
      role?: WorkspaceMemberRole;
      canManage?: boolean;
    }>;
    create(body: CreateUserWebhookInput): Promise<AnyCreateWebhookResponse>;
    get(id: string): Promise<AnyWebhookSubscription>;
    update(id: string, body: UpdateMyWebhookInput): Promise<AnyWebhookSubscription>;
    delete(id: string): Promise<void>;
    deliveries(
      id: string,
      query?: { failed?: boolean; limit?: number },
    ): Promise<{ data?: WebhookDeliveryRow[] }>;
    rotateSecret(id: string): Promise<RotateUserWebhookSecretResponse>;
    test(id: string): Promise<TestUserWebhookResponse>;
  };
}

/** A subscription row as returned by either owner's list endpoint. */
export type AnyWebhookListItem = UserWebhookListItem | WorkspaceWebhookListItem;

/** A subscription row as returned by either owner's single-item routes
 * (get/update). Delivery-health fields ride along on these responses even
 * though the wire type only guarantees them on list/create rows. */
export type AnyWebhookSubscription = (UserWebhookSubscription | WorkspaceWebhookSubscription) &
  Partial<UserWebhookDeliveryHealth>;

/** The create response for either owner. */
export type AnyCreateWebhookResponse = CreateUserWebhookResponse | CreateWorkspaceWebhookResponse;

export interface CreateUserWebhookInput {
  url: string;
  scope?: UserWebhookScope;
  orgSlug?: string;
  orgId?: string;
  sourceSlug?: string;
  sourceId?: string;
  productSlug?: string;
  productId?: string;
  releaseType?: UserWebhookReleaseTypeFilter;
  description?: string | null;
  format?: UserWebhookFormat;
}

export type UpdateMyWebhookInput = {
  url?: string;
  description?: string | null;
  enabled?: boolean;
  sourceSlug?: string;
  sourceId?: string | null;
  productSlug?: string;
  productId?: string | null;
  releaseType?: UserWebhookReleaseTypeFilter | null;
  format?: UserWebhookFormat;
};

export interface ListWebhooksResult {
  subscriptions: AnyWebhookListItem[];
  /** Present for workspace-owned lists: the caller's role in that workspace. */
  role?: WorkspaceMemberRole;
  /** Present for workspace-owned lists: whether the caller can create/edit/delete. */
  canManage?: boolean;
}

/** List an owner's webhook subscriptions. */
export async function listWebhooks(
  owner: WebhookOwner,
  opts?: { enabled?: boolean },
): Promise<ListWebhooksResult> {
  const res = await find((c) => hooks(c, owner).list({ enabled: opts?.enabled }));
  return {
    subscriptions: res?.subscriptions ?? [],
    role: res?.role,
    canManage: res?.canManage,
  };
}

/** List the signed-in user's own webhook subscriptions. */
export async function listMyWebhooks(opts?: { enabled?: boolean }): Promise<UserWebhookListItem[]> {
  const { subscriptions } = await listWebhooks(MY_WEBHOOKS, opts);
  return subscriptions as UserWebhookListItem[];
}

/** Register a webhook for the given owner. The `signingKey` is shown once. */
export async function createWebhook(
  owner: WebhookOwner,
  input: CreateUserWebhookInput,
): Promise<AnyCreateWebhookResponse> {
  return call((c) => hooks(c, owner).create(input));
}

/** Register a self-serve webhook. The `signingKey` is shown once. */
export async function createMyWebhook(
  input: CreateUserWebhookInput,
): Promise<CreateUserWebhookResponse> {
  return createWebhook(MY_WEBHOOKS, input) as Promise<CreateUserWebhookResponse>;
}

/** Read one subscription owned by `owner`. Returns null on 404. */
export async function getWebhook(
  owner: WebhookOwner,
  id: string,
): Promise<AnyWebhookSubscription | null> {
  return find((c) => hooks(c, owner).get(id));
}

/** Read one of the signed-in user's own subscriptions. Returns null on 404. */
export async function getMyWebhook(id: string): Promise<AnyWebhookSubscription | null> {
  return getWebhook(MY_WEBHOOKS, id);
}

export async function updateWebhook(
  owner: WebhookOwner,
  id: string,
  fields: UpdateMyWebhookInput,
): Promise<AnyWebhookSubscription> {
  return call((c) => hooks(c, owner).update(id, fields));
}

export async function updateMyWebhook(
  id: string,
  fields: UpdateMyWebhookInput,
): Promise<AnyWebhookSubscription> {
  return updateWebhook(MY_WEBHOOKS, id, fields);
}

export async function deleteWebhook(owner: WebhookOwner, id: string): Promise<void> {
  await call((c) => hooks(c, owner).delete(id));
}

export async function deleteMyWebhook(id: string): Promise<void> {
  return deleteWebhook(MY_WEBHOOKS, id);
}

export async function rotateWebhookSecret(
  owner: WebhookOwner,
  id: string,
): Promise<RotateUserWebhookSecretResponse> {
  return call((c) => hooks(c, owner).rotateSecret(id));
}

export async function rotateMyWebhookSecret(id: string): Promise<RotateUserWebhookSecretResponse> {
  return rotateWebhookSecret(MY_WEBHOOKS, id);
}

export async function testWebhook(
  owner: WebhookOwner,
  id: string,
): Promise<TestUserWebhookResponse> {
  return call((c) => hooks(c, owner).test(id));
}

export async function testMyWebhook(id: string): Promise<TestUserWebhookResponse> {
  return testWebhook(MY_WEBHOOKS, id);
}

export async function getWebhookDeliveries(
  owner: WebhookOwner,
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[]> {
  const res = await find((c) =>
    hooks(c, owner).deliveries(id, { failed: opts?.failed || undefined, limit: opts?.limit }),
  );
  return res?.data ?? [];
}

export async function getMyWebhookDeliveries(
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[]> {
  return getWebhookDeliveries(MY_WEBHOOKS, id, opts);
}
