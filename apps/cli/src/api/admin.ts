import { apiFetch } from "./core.js";

// ── User roles (OAuth scope entitlement) ──

/** A user's role row as returned by `/v1/admin/users/role`. `role` NULL → read-only. */
export interface UserRole {
  userId: string;
  email: string;
  role: string | null;
}

/** The PATCH response, which also carries the role the user held before the change. */
export interface SetUserRoleResult extends UserRole {
  previousRole: string | null;
}

/** Exactly one of email/userId must be set; the route enforces this too. */
export type UserIdentifier = { email?: string; userId?: string };

/**
 * Fail closed before building a query/body: a zero-identifier id would emit
 * `email=` and both-set would silently prefer userId — either is a malformed
 * request. Require exactly one.
 */
function assertSingleIdentifier(id: UserIdentifier): void {
  const hasEmail = id.email != null && id.email !== "";
  const hasUserId = id.userId != null && id.userId !== "";
  if (hasEmail === hasUserId) {
    throw new Error("UserIdentifier requires exactly one of email or userId");
  }
}

function userRoleQuery(id: UserIdentifier): string {
  return id.userId
    ? `userId=${encodeURIComponent(id.userId)}`
    : `email=${encodeURIComponent(id.email ?? "")}`;
}

/** Read a user's current role. Returns null when no such user exists (404). */
export async function getUserRole(id: UserIdentifier): Promise<UserRole | null> {
  assertSingleIdentifier(id);
  return apiFetch<UserRole | null>(`/v1/admin/users/role?${userRoleQuery(id)}`);
}

/** Set a user's role (user | curator | admin). Throws on 400/404. */
export async function setUserRole(id: UserIdentifier, role: string): Promise<SetUserRoleResult> {
  assertSingleIdentifier(id);
  return apiFetch<SetUserRoleResult>(`/v1/admin/users/role`, {
    method: "PATCH",
    body: JSON.stringify({ ...id, role }),
  });
}

/** List users holding a curator or admin role. */
export async function listUserRoles(): Promise<UserRole[]> {
  const res = await apiFetch<{ users: UserRole[] } | null>(`/v1/admin/users/roles`);
  // An empty list is a 200 `{ users: [] }`; apiFetch only yields null on a 404,
  // which here means the admin route is missing/undeployed. Surface that instead
  // of masking it as "no curator/admin users".
  if (!res) {
    throw new Error(
      "listUserRoles: 404/empty from /v1/admin/users/roles — is the admin users route deployed?",
    );
  }
  return res.users ?? [];
}

// ── OAuth clients ("Sign in with Releases") ──

/** Secret-free public view of an OAuth client, as returned by every read path. */
export interface OAuthClient {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  /** Maps to skip_consent — a trusted client bypasses the consent screen. */
  trusted: boolean;
  /**
   * Operator-set "Verified by Releases Index" consent-page badge. Optional: an
   * API that predates the flag omits it.
   */
  official?: boolean;
  disabled: boolean;
  /** A public (PKCE) client has no secret (`tokenEndpointAuthMethod: "none"`). */
  public: boolean;
  type: string | null;
  tokenEndpointAuthMethod: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** Fields accepted by `POST /v1/admin/oauth/clients`. */
export interface CreateOAuthClientInput {
  name?: string;
  redirectUris: string[];
  scopes: string[];
  trusted?: boolean;
  /** Omit to let the server default apply (`true`). */
  official?: boolean;
  /** `none` ⇒ secretless public/PKCE client. */
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  type?: "web" | "native" | "user-agent-based";
  grantTypes?: string[];
  requirePKCE?: boolean;
  clientUri?: string;
  logoUri?: string;
}

/** Create response — carries the `reloc_` secret exactly once (null for public clients). */
export interface CreateOAuthClientResult extends OAuthClient {
  clientSecret: string | null;
}

/** Register a new OAuth client. The `clientSecret` is shown once and never again. */
export async function createOAuthClient(
  input: CreateOAuthClientInput,
): Promise<CreateOAuthClientResult> {
  return apiFetch<CreateOAuthClientResult>(`/v1/admin/oauth/clients`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** List all registered OAuth clients (secret-free). */
export async function listOAuthClients(): Promise<OAuthClient[]> {
  const res = await apiFetch<{ clients: OAuthClient[] } | null>(`/v1/admin/oauth/clients`);
  if (!res) {
    throw new Error(
      "listOAuthClients: 404 from /v1/admin/oauth/clients — is the admin oauth route deployed?",
    );
  }
  return res.clients ?? [];
}

/** Read one OAuth client by id. Returns null when no such client exists (404). */
export async function getOAuthClient(clientId: string): Promise<OAuthClient | null> {
  return apiFetch<OAuthClient | null>(`/v1/admin/oauth/clients/${encodeURIComponent(clientId)}`);
}

/** Atomically update the `disabled`, `trusted` and/or `official` flag on a client. */
export async function updateOAuthClient(
  clientId: string,
  fields: { disabled?: boolean; trusted?: boolean; official?: boolean },
): Promise<OAuthClient> {
  return apiFetch<OAuthClient>(`/v1/admin/oauth/clients/${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

/** Rotate a confidential client's secret; returns the new `reloc_` secret once. */
export async function rotateOAuthClientSecret(
  clientId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  return apiFetch<{ clientId: string; clientSecret: string }>(
    `/v1/admin/oauth/clients/${encodeURIComponent(clientId)}/rotate-secret`,
    { method: "POST" },
  );
}

/** Delete a client (a hard removal — disable instead if you want a reversible kill switch). */
export async function deleteOAuthClient(
  clientId: string,
): Promise<{ clientId: string; deleted: boolean }> {
  return apiFetch<{ clientId: string; deleted: boolean }>(
    `/v1/admin/oauth/clients/${encodeURIComponent(clientId)}`,
    { method: "DELETE" },
  );
}
