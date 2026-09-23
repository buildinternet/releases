/**
 * Browser client for self-serve webhook subscriptions. Personal subscriptions
 * live at `/v1/me/webhooks`; workspace-owned ones at
 * `/v1/workspaces/:workspaceId/webhooks` (#2324). Both share the same request
 * shapes, so {@link webhookClient} builds the fetch calls once, parameterized
 * by base path, and the personal/workspace exports below are thin bindings
 * onto it. Uses `credentials: "include"` so the cross-subdomain session
 * cookie rides along.
 */

import type {
  CreateUserWebhookResponse,
  CreateWorkspaceWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookListResponse,
  UserWebhookReleaseTypeFilter,
  UserWebhookScope,
  WebhookDeliveryRow,
  WorkspaceWebhookListItem,
  WorkspaceWebhookListResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

export type {
  CreateUserWebhookResponse,
  CreateWorkspaceWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookScope,
  WebhookDeliveryRow,
  WorkspaceWebhookListItem,
  WorkspaceWebhookListResponse,
};

export type WebhookCreateInput = {
  url: string;
  scope?: UserWebhookScope;
  orgSlug?: string;
  orgId?: string;
  productSlug?: string;
  sourceSlug?: string;
  releaseType?: UserWebhookReleaseTypeFilter;
  format?: UserWebhookFormat;
  description?: string;
};

export type WebhookUpdateInput = {
  url?: string;
  description?: string | null;
  enabled?: boolean;
};

/**
 * Builds the webhook CRUD calls against `${apiBase()}${basePath}` — either
 * `/v1/me/webhooks` (personal) or `/v1/workspaces/:workspaceId/webhooks`
 * (workspace-owned, #2324). Every function below is otherwise identical
 * between the two surfaces.
 */
function webhookClient<TListItem, TListResponse, TCreateResponse>(basePath: string) {
  function url(path = ""): string {
    return `${apiBase()}${basePath}${path}`;
  }

  return {
    async list(): Promise<TListResponse> {
      const res = await fetch(url(), { credentials: "include" });
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to load webhooks (${res.status})`));
      return (await res.json()) as TListResponse;
    },

    async create(input: WebhookCreateInput): Promise<TCreateResponse> {
      const res = await fetch(url(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to create webhook (${res.status})`));
      return (await res.json()) as TCreateResponse;
    },

    async update(id: string, patch: WebhookUpdateInput): Promise<TListItem> {
      const res = await fetch(url(`/${encodeURIComponent(id)}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to update webhook (${res.status})`));
      return (await res.json()) as TListItem;
    },

    async delete(id: string): Promise<void> {
      const res = await fetch(url(`/${encodeURIComponent(id)}`), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to delete webhook (${res.status})`));
    },

    async rotateSecret(id: string): Promise<RotateUserWebhookSecretResponse> {
      const res = await fetch(url(`/${encodeURIComponent(id)}/rotate-secret`), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to rotate signing key (${res.status})`));
      return (await res.json()) as RotateUserWebhookSecretResponse;
    },

    async test(id: string): Promise<TestUserWebhookResponse> {
      const res = await fetch(url(`/${encodeURIComponent(id)}/test`), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Failed to send test (${res.status})`));
      return (await res.json()) as TestUserWebhookResponse;
    },

    /** Returns `null` when delivery history is unavailable (501). */
    async listDeliveries(
      id: string,
      opts?: { failed?: boolean; limit?: number },
    ): Promise<WebhookDeliveryRow[] | null> {
      const params = new URLSearchParams();
      if (opts?.failed) params.set("failed", "true");
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const res = await fetch(url(`/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ""}`), {
        credentials: "include",
      });
      if (res.status === 501) return null;
      if (!res.ok)
        throw new Error(await errorMessage(res, `Failed to load deliveries (${res.status})`));
      const body = (await res.json()) as { data?: WebhookDeliveryRow[] };
      return body.data ?? [];
    },
  };
}

// ── Personal (`/v1/me/webhooks`) ──

const personal = webhookClient<
  UserWebhookListItem,
  UserWebhookListResponse,
  CreateUserWebhookResponse
>("/v1/me/webhooks");

export async function listWebhooks(): Promise<UserWebhookListItem[]> {
  return (await personal.list()).subscriptions;
}

export async function createWebhook(input: WebhookCreateInput): Promise<CreateUserWebhookResponse> {
  return personal.create(input);
}

export async function updateWebhook(
  id: string,
  patch: WebhookUpdateInput,
): Promise<UserWebhookListItem> {
  return personal.update(id, patch);
}

export async function deleteWebhook(id: string): Promise<void> {
  return personal.delete(id);
}

export async function rotateWebhookSecret(id: string): Promise<RotateUserWebhookSecretResponse> {
  return personal.rotateSecret(id);
}

export async function testWebhook(id: string): Promise<TestUserWebhookResponse> {
  return personal.test(id);
}

export async function listWebhookDeliveries(
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[] | null> {
  return personal.listDeliveries(id, opts);
}

// ── Workspace-owned (`/v1/workspaces/:workspaceId/webhooks`, #2324) ──

function workspaceClient(workspaceId: string) {
  return webhookClient<
    WorkspaceWebhookListItem,
    WorkspaceWebhookListResponse,
    CreateWorkspaceWebhookResponse
  >(`/v1/workspaces/${encodeURIComponent(workspaceId)}/webhooks`);
}

export async function listWorkspaceWebhooks(
  workspaceId: string,
): Promise<WorkspaceWebhookListResponse> {
  return workspaceClient(workspaceId).list();
}

export async function createWorkspaceWebhook(
  workspaceId: string,
  input: WebhookCreateInput,
): Promise<CreateWorkspaceWebhookResponse> {
  return workspaceClient(workspaceId).create(input);
}

export async function updateWorkspaceWebhook(
  workspaceId: string,
  id: string,
  patch: WebhookUpdateInput,
): Promise<WorkspaceWebhookListItem> {
  return workspaceClient(workspaceId).update(id, patch);
}

export async function deleteWorkspaceWebhook(workspaceId: string, id: string): Promise<void> {
  return workspaceClient(workspaceId).delete(id);
}

export async function rotateWorkspaceWebhookSecret(
  workspaceId: string,
  id: string,
): Promise<RotateUserWebhookSecretResponse> {
  return workspaceClient(workspaceId).rotateSecret(id);
}

export async function testWorkspaceWebhook(
  workspaceId: string,
  id: string,
): Promise<TestUserWebhookResponse> {
  return workspaceClient(workspaceId).test(id);
}

export async function listWorkspaceWebhookDeliveries(
  workspaceId: string,
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[] | null> {
  return workspaceClient(workspaceId).listDeliveries(id, opts);
}
