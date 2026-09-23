/**
 * Deep-link into the Account → Webhooks & API create form, prefilled for one
 * org. Org pages use {@link orgWebhookCreatePath}; the settings page parses
 * the same query via {@link parseWebhookCreatePrefill}.
 */

import type { UserWebhookScope } from "@buildinternet/releases-api-types";

/** Conservative org-slug check — rejects path/query injection into the form. */
const ORG_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type WebhookCreatePrefill = {
  scope: "org";
  orgSlug: string;
};

export type WebhookCreateInitialState = {
  scope: UserWebhookScope;
  orgSlug: string;
};

function firstParam(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Read `?scope=org&org=<slug>` (scope may be omitted when `org` is present).
 * Returns null for follows, missing/invalid slugs, or an unknown scope.
 */
export function parseWebhookCreatePrefill(params: {
  scope?: string | string[] | null;
  org?: string | string[] | null;
}): WebhookCreatePrefill | null {
  const org = firstParam(params.org)?.trim();
  const scope = firstParam(params.scope)?.trim();
  if (!org || !ORG_SLUG.test(org)) return null;
  if (scope && scope !== "org") return null;
  return { scope: "org", orgSlug: org };
}

/** Signed-in deep-link: create form, org scope, hash-scrolled to the form. */
export function orgWebhookCreatePath(orgSlug: string): string {
  const qs = new URLSearchParams({ scope: "org", org: orgSlug });
  return `/account/webhooks?${qs.toString()}#add-webhook`;
}

/**
 * Signed-in deep-link into the workspace webhooks page (#2324), prefilled for
 * one org. Workspace webhooks are org-scoped only, so there's no `scope` param.
 */
export function orgWorkspaceWebhookCreatePath(orgSlug: string): string {
  const qs = new URLSearchParams({ org: orgSlug });
  return `/account/workspace-webhooks?${qs.toString()}#add-webhook`;
}

/**
 * Sign-in redirect that preserves org prefill. Hash is omitted — fragments
 * do not survive the server-side post-auth redirect.
 */
export function webhookCreateLoginPath(prefill: WebhookCreatePrefill | null): string {
  const target =
    prefill != null
      ? `/account/webhooks?${new URLSearchParams({ scope: prefill.scope, org: prefill.orgSlug })}`
      : "/account/webhooks";
  return `/login?redirect=${encodeURIComponent(target)}`;
}

export function webhookCreateInitialState(
  prefill: WebhookCreatePrefill | null,
): WebhookCreateInitialState {
  if (prefill) return { scope: "org", orgSlug: prefill.orgSlug };
  return { scope: "follows", orgSlug: "" };
}
